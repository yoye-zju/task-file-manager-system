#!/usr/bin/env python3
"""Test both services are running."""
import urllib.request
import json
import sys

results = []

# Test File Manager (3456)
try:
    r = urllib.request.urlopen('http://127.0.0.1:3456/api/health', timeout=5)
    data = json.loads(r.read())
    results.append(("FileManager(3456) health", f"OK - {data}"))
except Exception as e:
    results.append(("FileManager(3456) health", f"ERROR - {e}"))

try:
    r = urllib.request.urlopen('http://127.0.0.1:3456/api/version', timeout=5)
    data = json.loads(r.read())
    results.append(("FileManager(3456) version", f"OK - {data}"))
except Exception as e:
    results.append(("FileManager(3456) version", f"ERROR - {e}"))

try:
    r = urllib.request.urlopen('http://127.0.0.1:3456/api/files?page=1&page_size=3', timeout=5)
    data = json.loads(r.read())
    results.append(("FileManager(3456) files", f"OK - total={data['total']}, returned={len(data['data'])}"))
except Exception as e:
    results.append(("FileManager(3456) files", f"ERROR - {e}"))

# Test Task Lens (8080)
try:
    r = urllib.request.urlopen('http://127.0.0.1:8080/', timeout=5)
    results.append(("TaskLens(8080) root", f"OK - status={r.status}, length={len(r.read())}"))
except Exception as e:
    results.append(("TaskLens(8080) root", f"ERROR - {e}"))

for name, result in results:
    status = "PASS" if result.startswith("OK") else "FAIL"
    print(f"[{status}] {name}: {result}")

# Final status
if all(r.startswith("OK") for _, r in results):
    print("\nAll services are healthy!")
    sys.exit(0)
else:
    print("\nSome services have issues!")
    sys.exit(1)
