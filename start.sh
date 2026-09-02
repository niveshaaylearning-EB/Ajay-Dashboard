#!/bin/bash
# Container entrypoint: initialize persistent data, then start supervisor
echo "[start] Initializing data directory..."
python /app/backend/init_data_dir.py
echo "[start] Starting services..."
exec supervisord -n -c /etc/supervisor/supervisord.conf
