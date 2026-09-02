"""Shared JSON persistence + GitHub-backed durability helpers.

backend/main.py and webportal/backend/main.py run in the same Python
process (webportal is mounted in-process — see backend/main.py's
importlib load) and both persist their JSON data files the same way:
write locally, then best-effort push to GitHub so data survives
redeploys on hosts with an ephemeral filesystem.
"""
import base64
import json
import os
import threading
import urllib.request


def github_push(repo_relative_path: str, content: str, raise_on_error: bool = False) -> None:
    """Push file content to the GitHub Contents API. No-op if GITHUB_TOKEN/GITHUB_REPO unset."""
    token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPO", "")
    if not token or not repo:
        return
    api_url = f"https://api.github.com/repos/{repo}/contents/{repo_relative_path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    try:
        try:
            req = urllib.request.Request(api_url, headers=headers)
            with urllib.request.urlopen(req, timeout=8) as r:
                sha = json.loads(r.read())["sha"]
        except Exception:
            sha = None
        body = json.dumps({
            "message": f"auto: update {os.path.basename(repo_relative_path)}",
            "content": base64.b64encode(content.encode()).decode(),
            **({"sha": sha} if sha else {}),
        }).encode()
        req2 = urllib.request.Request(api_url, data=body, headers=headers, method="PUT")
        urllib.request.urlopen(req2, timeout=10)
    except Exception as e:
        print(f"[github-push] {repo_relative_path}: {e}")
        if raise_on_error:
            raise


def save_json(filepath: str, data, repo_relative_path: str, sync: bool = False, raise_on_error: bool = False) -> None:
    """Write JSON to disk, then push to GitHub (blocking if sync else background thread)."""
    content = json.dumps(data, indent=2, ensure_ascii=False)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)
    if sync:
        github_push(repo_relative_path, content, raise_on_error=raise_on_error)
    else:
        threading.Thread(target=github_push, args=(repo_relative_path, content), daemon=True).start()


def load_json(filepath: str, default):
    try:
        if os.path.exists(filepath):
            with open(filepath, encoding="utf-8") as f:
                return json.load(f)
    except Exception:
        pass
    return default
