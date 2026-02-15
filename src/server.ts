/**
 * WHM Dashboard - Express Server
 * Web-based CI/CD monitoring dashboard
 */

import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory storage for repositories
interface RepoConfig {
  id: string;
  platform: string;
  owner: string;
  name: string;
  token: string;
}

let repos: RepoConfig[] = [];

// API Routes

// Get all repositories
app.get('/api/repos', (req, res) => {
  res.json(repos.map(r => ({ ...r, token: '***' })));
});

// Add repository
app.post('/api/repos', (req, res) => {
  const { platform, owner, name, token } = req.body;
  const repo: RepoConfig = {
    id: `${owner}/${name}`,
    platform,
    owner,
    name,
    token,
  };
  repos.push(repo);
  res.json({ success: true, repo: { ...repo, token: '***' } });
});

// Remove repository
app.delete('/api/repos/:id', (req, res) => {
  const { id } = req.params;
  repos = repos.filter(r => r.id !== id);
  res.json({ success: true });
});

// Get pipeline status for a repository
app.get('/api/repos/:id/status', async (req, res) => {
  const { id } = req.params;
  const repo = repos.find(r => r.id === id);
  
  if (!repo) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    let status: any = {};
    
    if (repo.platform === 'github') {
      const response = await axios.get(
        `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/runs`,
        {
          headers: {
            'Authorization': `Bearer ${repo.token}`,
            'Accept': 'application/vnd.github+json',
          },
          params: { per_page: 10 },
        }
      );
      
      const runs = response.data.workflow_runs || [];
      const latest = runs[0];
      const successful = runs.filter((r: any) => r.conclusion === 'success').length;
      
      status = {
        platform: 'github',
        lastRun: latest ? {
          id: latest.id,
          status: latest.conclusion || latest.status,
          duration: Math.floor((new Date(latest.updated_at).getTime() - new Date(latest.run_started_at).getTime()) / 1000),
          timestamp: latest.updated_at,
        } : null,
        successRate: runs.length > 0 ? Math.round((successful / runs.length) * 100) : 0,
        runs: runs.slice(0, 5).map((r: any) => ({
          id: r.id,
          status: r.conclusion || r.status,
          duration: Math.floor((new Date(r.updated_at).getTime() - new Date(r.run_started_at).getTime()) / 1000),
          timestamp: r.updated_at,
          branch: r.head_branch,
        })),
      };
    } else if (repo.platform === 'gitlab') {
      const projectId = encodeURIComponent(`${repo.owner}/${repo.name}`);
      const response = await axios.get(
        `https://gitlab.com/api/v4/projects/${projectId}/pipelines`,
        {
          headers: { 'PRIVATE-TOKEN': repo.token },
          params: { per_page: 10 },
        }
      );
      
      const pipelines = response.data || [];
      const latest = pipelines[0];
      const successful = pipelines.filter((p: any) => p.status === 'success').length;
      
      status = {
        platform: 'gitlab',
        lastRun: latest ? {
          id: latest.id,
          status: latest.status,
          duration: Math.floor((new Date(latest.updated_at).getTime() - new Date(latest.created_at).getTime()) / 1000),
          timestamp: latest.updated_at,
        } : null,
        successRate: pipelines.length > 0 ? Math.round((successful / pipelines.length) * 100) : 0,
        runs: pipelines.slice(0, 5).map((p: any) => ({
          id: p.id,
          status: p.status,
          duration: Math.floor((new Date(p.updated_at).getTime() - new Date(p.created_at).getTime()) / 1000),
          timestamp: p.updated_at,
          branch: p.ref,
        })),
      };
    }

    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Get all statuses
app.get('/api/status', async (req, res) => {
  const statuses = await Promise.all(
    repos.map(async (repo) => {
      try {
        let status: any = {};
        
        if (repo.platform === 'github') {
          const response = await axios.get(
            `https://api.github.com/repos/${repo.owner}/${repo.name}/actions/runs`,
            {
              headers: {
                'Authorization': `Bearer ${repo.token}`,
                'Accept': 'application/vnd.github+json',
              },
              params: { per_page: 1 },
            }
          );
          
          const latest = response.data.workflow_runs?.[0];
          status = {
            id: repo.id,
            platform: repo.platform,
            owner: repo.owner,
            name: repo.name,
            status: latest?.conclusion || latest?.status || 'unknown',
            timestamp: latest?.updated_at,
          };
        } else if (repo.platform === 'gitlab') {
          const projectId = encodeURIComponent(`${repo.owner}/${repo.name}`);
          const response = await axios.get(
            `https://gitlab.com/api/v4/projects/${projectId}/pipelines`,
            {
              headers: { 'PRIVATE-TOKEN': repo.token },
              params: { per_page: 1 },
            }
          );
          
          const latest = response.data?.[0];
          status = {
            id: repo.id,
            platform: repo.platform,
            owner: repo.owner,
            name: repo.name,
            status: latest?.status || 'unknown',
            timestamp: latest?.updated_at,
          };
        }
        
        return status;
      } catch (error) {
        return {
          id: repo.id,
          platform: repo.platform,
          owner: repo.owner,
          name: repo.name,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    })
  );
  
  res.json(statuses);
});

// Serve static dashboard
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WHM Dashboard - CI/CD Monitor</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { font-size: 1.8rem; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }
    .card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .repo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
    .repo-card { background: #1e293b; border-radius: 12px; padding: 16px; border: 1px solid #334155; }
    .repo-card.pass { border-left: 4px solid #22c55e; }
    .repo-card.fail { border-left: 4px solid #ef4444; }
    .repo-card.running { border-left: 4px solid #f59e0b; }
    .repo-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .repo-name { font-weight: 600; font-size: 1rem; }
    .repo-platform { font-size: 0.75rem; color: #94a3b8; background: #334155; padding: 2px 8px; border-radius: 4px; }
    .status { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; }
    .status-icon { width: 10px; height: 10px; border-radius: 50%; }
    .status-icon.pass { background: #22c55e; }
    .status-icon.fail { background: #ef4444; }
    .status-icon.running { background: #f59e0b; animation: pulse 1s infinite; }
    .status-icon.unknown { background: #64748b; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .form { display: flex; gap: 10px; flex-wrap: wrap; }
    input, select { background: #334155; border: 1px solid #475569; color: #e2e8f0; padding: 10px 14px; border-radius: 8px; font-size: 0.9rem; }
    input::placeholder { color: #64748b; }
    input:focus, select:focus { outline: none; border-color: #3b82f6; }
    button { background: #3b82f6; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
    button:hover { background: #2563eb; }
    .empty { text-align: center; padding: 40px; color: #64748b; }
    .refresh-btn { background: #475569; margin-left: auto; }
    .refresh-btn:hover { background: #64748b; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔔 WHM Dashboard</h1>
    
    <div class="card">
      <h3 style="margin-bottom: 15px;">Add Repository</h3>
      <form class="form" id="addForm">
        <select id="platform" required>
          <option value="github">GitHub</option>
          <option value="gitlab">GitLab</option>
        </select>
        <input type="text" id="owner" placeholder="Owner/Org" required>
        <input type="text" id="name" placeholder="Repository name" required>
        <input type="password" id="token" placeholder="API Token" required>
        <button type="submit">Add</button>
      </form>
    </div>

    <div class="card">
      <div style="display: flex; align-items: center; margin-bottom: 15px;">
        <h3>Repositories</h3>
        <button class="refresh-btn" onclick="loadRepos()">↻ Refresh</button>
      </div>
      <div id="repoList" class="repo-grid"></div>
      <div id="empty" class="empty">No repositories added yet</div>
    </div>
  </div>

  <script>
    async function loadRepos() {
      const res = await fetch('/api/repos');
      const repos = await res.json();
      
      const list = document.getElementById('repoList');
      const empty = document.getElementById('empty');
      
      if (repos.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
      }
      
      empty.style.display = 'none';
      
      const statuses = await fetch('/api/status').then(r => r.json());
      const statusMap = {};
      statuses.forEach(s => statusMap[s.id] = s);
      
      list.innerHTML = repos.map(repo => {
        const status = statusMap[repo.id] || {};
        const statusClass = status.status === 'success' ? 'pass' : 
                          status.status === 'failure' || status.status === 'failed' ? 'fail' :
                          status.status === 'running' || status.status === 'pending' ? 'running' : 'unknown';
        
        return \`
          <div class="repo-card \${statusClass}">
            <div class="repo-header">
              <span class="repo-name">\${repo.owner}/\${repo.name}</span>
              <span class="repo-platform">\${repo.platform}</span>
            </div>
            <div class="status">
              <span class="status-icon \${statusClass}"></span>
              <span>\${status.status || 'unknown'}</span>
            </div>
            <button onclick="removeRepo('\${repo.id}')" style="margin-top: 10px; background: #ef4444; padding: 6px 12px; font-size: 0.8rem;">Remove</button>
          </div>
        \`;
      }).join('');
    }
    
    async function removeRepo(id) {
      await fetch(\`/api/repos/\${encodeURIComponent(id)}\`, { method: 'DELETE' });
      loadRepos();
    }
    
    document.getElementById('addForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const platform = document.getElementById('platform').value;
      const owner = document.getElementById('owner').value;
      const name = document.getElementById('name').value;
      const token = document.getElementById('token').value;
      
      await fetch('/api/repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, owner, name, token }),
      });
      
      document.getElementById('addForm').reset();
      loadRepos();
    });
    
    loadRepos();
    setInterval(loadRepos, 30000);
  </script>
</body>
</html>
  `;
  
  res.send(html);
});

app.listen(PORT, () => {
  console.log(`WHM Dashboard running at http://localhost:${PORT}`);
});
