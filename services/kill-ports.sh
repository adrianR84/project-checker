#!/bin/bash
for port in 3000 3001; do
  pid=$(netstat -ano 2>/dev/null | grep ":$port " | grep LISTENING | awk '{print $5}' | head -1)
  if [ -n "$pid" ]; then
    kill -f "$pid" 2>/dev/null && echo "Killed $port (PID $pid)" || echo "Failed to kill $port"
  else
    echo "Port $port free"
  fi
done
