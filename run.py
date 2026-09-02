"""
Niveshaay Equity Basket Tracker — single-window launcher.
Runs:  frontend build  →  webportal backend (:8101)  →  main backend (:8100)
All output is prefixed and shown in this window.
Press Ctrl+C to stop everything.
"""
import os, sys, subprocess, threading, time, socket, webbrowser

def kill_port(port):
    """Kill any process listening on the given TCP port."""
    try:
        if sys.platform == "win32":
            subprocess.run(
                f'for /f "tokens=5" %a in (\'netstat -ano ^| findstr ":{port}.*LISTENING"\') do taskkill /PID %a /F',
                shell=True, capture_output=True, text=True
            )
        else:
            subprocess.run(
                f"lsof -i:{port} -t | xargs kill -9",
                shell=True, capture_output=True, text=True
            )
    except Exception:
        pass

BASE         = os.path.dirname(os.path.abspath(__file__))
FRONTEND     = os.path.join(BASE, "frontend")
BACKEND      = os.path.join(BASE, "backend")
WEBPORTAL    = os.path.join(BASE, "webportal", "backend")
WP_FRONTEND  = os.path.join(BASE, "webportal", "frontend")
if sys.platform == "win32":
    PYTHON = os.path.join(BACKEND, "venv", "Scripts", "python.exe")
else:
    PYTHON = os.path.join(BACKEND, "venv_mac", "bin", "python")
    if not os.path.exists(PYTHON):
        PYTHON = "python3"

# ── Colours (works in Windows Terminal / PowerShell; ignored in plain cmd) ──
C = {
    "reset":  "\033[0m",
    "green":  "\033[32m",
    "cyan":   "\033[36m",
    "yellow": "\033[33m",
    "red":    "\033[31m",
    "bold":   "\033[1m",
}

def clr(text, *codes):
    return "".join(C[c] for c in codes) + text + C["reset"]

def get_lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0)
        s.connect(("10.254.254.254", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def stream(proc, tag, color):
    """Forward all stdout+stderr lines from proc to this console."""
    for line in proc.stdout:
        line = line.rstrip()
        if line:
            print(clr(f"[{tag}] ", color) + line)
    proc.wait()


# ── Banner ────────────────────────────────────────────────────────────────────
os.system("color 0a")   # green text in plain cmd
print(clr("=" * 62, "bold"))
print(clr("   Niveshaay Portfolio Intelligence Center", "bold", "green"))
print(clr("=" * 62, "bold"))
print()

# ── Step 0: Kill any stale servers on our ports ──────────────────────────────
print(clr("[0/3] Clearing ports 8100 and 8101 …", "yellow"))
kill_port(8100)
kill_port(8101)
time.sleep(1)

# ── Step 1: Build both React frontends ───────────────────────────────────────
print(clr("[1/3] Building React frontends …", "yellow"))

wp_build = subprocess.run("npm run build", cwd=os.path.normpath(WP_FRONTEND), shell=True)
if wp_build.returncode != 0:
    print(clr("ERROR: webportal frontend build failed. Fix errors and rerun.", "red"))
    sys.exit(1)
print(clr("      Webportal frontend build done.", "green"))

build = subprocess.run("npm run build", cwd=FRONTEND, shell=True)
if build.returncode != 0:
    print(clr("ERROR: main frontend build failed. Fix errors and rerun.", "red"))
    sys.exit(1)
print(clr("      Main frontend build done.\n", "green"))

# ── Step 2: Start webportal backend (:8101) ───────────────────────────────────
print(clr("[2/3] Starting Actual Portfolio backend on :8101 …", "yellow"))
wp_proc = subprocess.Popen(
    [PYTHON, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8101"],
    cwd=os.path.normpath(WEBPORTAL),
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1,
    env={**os.environ, "PYTHONUNBUFFERED": "1"},
)
threading.Thread(target=stream, args=(wp_proc, "webportal", "cyan"), daemon=True).start()

# ── Step 3: Start main backend (:8100) ───────────────────────────────────────
print(clr("[3/3] Starting Main backend on :8100 …\n", "yellow"))
main_proc = subprocess.Popen(
    [PYTHON, "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"],
    cwd=BACKEND,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, bufsize=1,
    env={**os.environ, "PYTHONUNBUFFERED": "1"},
)
threading.Thread(target=stream, args=(main_proc, "backend ", "green"), daemon=True).start()

# ── Wait a moment then show URLs ──────────────────────────────────────────────
time.sleep(2)
lan_ip = get_lan_ip()
print()
print(clr("=" * 62, "bold"))
print(clr("  Ready!  Access the app at:", "bold"))
print(f"   This PC  : {clr('http://localhost:8100', 'cyan', 'bold')}")
print(f"   WiFi LAN : {clr(f'http://{lan_ip}:8100', 'cyan', 'bold')}  <- share this")
print(clr("=" * 62, "bold"))
print(clr("  Press Ctrl+C to stop all servers.\n", "yellow"))

webbrowser.open("http://localhost:8100")

# ── Keep alive; exit when a server dies or user presses Ctrl+C ────────────────
try:
    while True:
        if wp_proc.poll() is not None:
            print(clr("\n[!] Webportal exited unexpectedly.", "red"))
            break
        if main_proc.poll() is not None:
            print(clr("\n[!] Main backend exited unexpectedly.", "red"))
            break
        time.sleep(1)
except KeyboardInterrupt:
    pass

print(clr("\nShutting down …", "yellow"))
for p in (wp_proc, main_proc):
    try:
        p.terminate()
    except Exception:
        pass
print(clr("All servers stopped.", "green"))
