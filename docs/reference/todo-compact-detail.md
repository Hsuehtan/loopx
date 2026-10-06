# Full selected Todo detail

Use the explicit detail view when reading the original requirements of one
selected Todo:

```sh
loopx --format json todo list --goal-id example-goal \
  --todo-id todo_work --agent-id codex-worker --compact-detail
```

The response retains one complete source body at `todo.text`, the current source
and canonical `authority_read` revision when available, identity, status, filters
and declared `relations`. It omits the duplicate `todos`, `agent_todos` and
`user_todos` views. Missing or filtered-out work remains `matched=false`,
`todo=null`, `not_found=true`; ambiguous source records fail rather than choosing
a body. Source errors retain the ordinary read failure, without a stale-display
fallback. Reading blocked, completed or archived work does not make it executable.

`--compact-detail` requires `--todo-id` and cannot combine with `--thin`.
The existing list, exact cold read and thin output remain unchanged when the
option is absent. Thin summaries can truncate a requirement's tail and should
not replace a full requirement read. Remove `--compact-detail` to use the prior
exact list output. No activation, authority, mutation or execution grant is added.

This is an explicit read lens in the existing typed Todo context owner, carried
by the registered `todo.context.page` method as `detail_payload`. The original
scoping, source restoration and authority selection remain with the existing
Todo reader. The lens neither reparses Goal acceptance nor invents a second
selection policy. Required-read producers must explicitly request this view;
adding the option alone does not change their commands or prove model adoption.

## 完整的单条 Todo 读取

在精确读取命令中加 `--compact-detail`，只返回一份完整的 `todo.text`，保留
来源、当前权威修订、身份、状态和关系。缺失或被过滤的 Todo 继续显示未匹配；
歧义和来源错误直接报错，不改用旧摘要。此视图不授予 claim、lease 或执行权限。

它需要 `--todo-id`，不能与 `--thin` 合用。未加此选项的 list、精确冷读取和
thin 输出保持兼容；移除选项即可恢复原输出。要求读取的生产方须显式采用该
视图，本切片不会自动修改其命令，也不证明模型已采用。
