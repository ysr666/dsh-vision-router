# 协作开发规则（本工作区所有 AI 会话必须遵守）

适用仓库：`dsh-vision-router`（本目录下的主树与各 worktree 均适用）。

1. **新功能开功能分支**：任何新功能 / 修复都从 `origin/main` 拉出独立分支开发
   （如 `feat/<名字>`、`fix/<名字>`），不要把开发中的改动直接推到 `main`。

2. **合并必须走 PR**：功能完成后推送分支、在 GitHub 开 Pull Request
   （`gh pr create --base main`），CI 全绿后才可合并；不在本地直接 force-push main。

3. **等用户本地实测确认再合并**：用户会在本地重启 `dsh web` 实测；只有用户明确说
   「能 merge / 合并」之后才能执行合并。合并后把 profile 指回 main
   （`dsh plugin --profile web add github:ysr666/dsh-vision-router`）并校验哈希一致。

4. 多会话并行时各用各的 worktree/分支，避免共享工作树的未提交改动互相踩踏；
   合并冲突时先 rebase 再 PR。
