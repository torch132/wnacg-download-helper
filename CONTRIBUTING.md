# 贡献与发布

## 版本更新流程

1. 修改功能后递增 `manifest.json` 中的版本号。
2. 运行 `node --test`，并执行全部 JavaScript 语法检查和 Manifest 引用检查。
3. 运行 `git diff --check`，并检查 `git diff --cached` 和 `git status`，确认没有本机路径、凭据或临时文件。
4. 创建 Git commit，并 push 到 `main`：

```bash
git add -A
git commit -m "描述本次更新"
git push origin main
```

代码注释和用户可见文案使用简体中文；Chrome API、Manifest、ZIP、MIME 等专业名词保留英文，避免不准确的生硬翻译。
