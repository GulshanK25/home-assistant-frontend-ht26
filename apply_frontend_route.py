"""Register a tracked Task Rotation panel in the Home Assistant frontend router."""
from pathlib import Path

path = Path('src/layouts/partial-panel-resolver.ts')
if not path.exists():
    raise SystemExit('Run this script from the FRONTEND repository root.')
content = path.read_text()
if '"task-rotation":' in content:
    print('Task Rotation route already configured')
    raise SystemExit(0)
needle = '  todo: { load: () => import("../panels/todo/ha-panel-todo") },'
replacement = needle + '\n  "task-rotation": {\n    load: () => import("../panels/task-rotation/ha-panel-task-rotation"),\n  },'
if needle not in content:
    raise SystemExit('Expected todo route not found; inspect partial-panel-resolver.ts before editing.')
path.write_text(content.replace(needle, replacement, 1))
print('Added Task Rotation route to', path)
