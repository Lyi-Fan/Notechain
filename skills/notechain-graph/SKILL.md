---
name: notechain-graph
description: Read and edit the Notechain asset architecture graph on Mac or Windows through its local CLI, including assets, directed relationships, evidence and layout. Use for Notechain graph operations, not general note editing or unrelated diagram generation.
---

Use the installed `ledger` command. On Mac the fallback is `/Applications/Notechain.app/Contents/MacOS/ledger`. On Windows use `ledger.exe` beside `Notechain.exe` (default installation: `$env:LOCALAPPDATA\Notechain\ledger.exe`). The desktop app must be running. No Node, Python, HTTP token or adapter script is needed.

In PowerShell invoke a quoted executable path with `&`. Prefer `--file PATCH.json` over inline JSON or pipelines: UTF-8, UTF-8 BOM and BOM-marked UTF-16 are supported, including PowerShell 5.1 `Out-File` output. Pass arguments separately; do not use `Invoke-Expression`, Bash heredocs or `&&`. Stdout is ASCII-safe JSON (Unicode escapes decode normally); `--output FILE` writes UTF-8. Check `$LASTEXITCODE` before parsing stdout. See `ledger --help` for options.

- `ledger graph cases`: list case IDs and names.
- `ledger graph get CASE_ID`: get compact JSON containing nodes, edges, evidence, positions and revision.
- Add `--sources ASSET_ID,ASSET_ID` to `get` when the task needs selected original note bodies (maximum 20). Bodies are omitted by default to save tokens.
- `ledger graph apply CASE_ID --file PATCH.json`: atomically apply a batch. `--file -` reads JSON from stdin. `--preview` returns the proposed graph without saving.
- `ledger graph generate CASE_ID`: regenerate from current notes, retaining saved positions. `--reset-layout` rearranges the automatic tree; independent manual-node coordinates stay intact. `--preview` avoids saving.
- `ledger graph help`: request schema and options. `--connection FILE` selects an isolated test client's control descriptor; omit it for the installed app.

Read the user's target case first. Preserve stable IDs. New node IDs use ASCII letters, digits, `_` or `-`, maximum 100 characters. A patch requires the current `revision` and a unique `requestId`:

```json
{"revision":4,"requestId":"graph-edit-unique-1","nodes":[{"id":"web","purpose":"Employee portal"}],"edges":[{"id":"web-host","source":"web","target":"host","label":"hosted on","evidence":[{"assetId":"web","quote":"Exact supporting text"}]}]}
```

Node fields: `id,address,title,purpose,note,categoryId`. Edges: `id,source,target,label,evidence,sourceHandle,targetHandle`; handles are `top,right,bottom,left`. Endpoints accept asset IDs, `case:CASE_ID`, or `category:CATEGORY_ID` belonging to the current case. Optional patch fields: `positions:{id:{x,y}}`, `remove:{nodes:[],edges:[]}`, `collapsed:[categoryId]`, `restoreHidden:true`. At most 500 items per collection per batch. Removing graph items preserves original notes. New nodes create real assets but are independent manual blocks: category assignment does not draw a line; add the desired edges explicitly. `entity:` nodes are extracted from notes and retain their provenance.

On 409, reread and reconcile the user's changes; do not overwrite with a stale snapshot. For a transport timeout, retry the identical patch/requestId once, then inspect the graph. Last 20 request receipts are retained. Keep node and edge IDs unchanged across retries.

Use evidence for factual relationships. A mention or a URL containing a host does not prove deployment, DNS resolution or ownership. Do not fabricate purposes, hosts or relationships to fill gaps. Preserve manual positions unless rearrangement was requested. Read only the requested case; do not send notes to external models unless the user authorized that destination.
