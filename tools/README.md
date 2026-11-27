# 放在这里的"外部程序"

这个目录里的东西**不会打进 npm 包**（`package.json` 的 `files` 不包含 `tools/`）。
它们随 GitHub Releases 分发，需要的人自己下载。

## frpc.exe

来自 [fatedier/frp](https://github.com/fatedier/frp) v0.71.1 的
`frp_0.71.1_windows_amd64.zip`，Apache-2.0，许可证全文见同目录 `frp-LICENSE`。

**谁需要它**：只在自己架中继服务器（自建中继 / 多人共用中继）时需要。
内网直连、Tailscale、Cloudflare 隧道（含固定域名的命名隧道）都用不到它。

**怎么用**：下载后放进插件数据目录的 `bin/` 下
（`%USERPROFILE%\.dsh\dsh-everywhere\bin\frpc.exe`），
或在插件设置里直接填它的完整路径。

## 为什么不随包分发

2026-11-27 起把可执行文件移出了 npm 包：它是发布扫描最刺眼的信号，
而 npm 的双用途政策只要求"能力被明确记录"，不要求随包带二进制。
功能没有减少——首次开启自建中继时会自动从这里对应的 Release 下载并校验，也可以手动下载。

## relay-server / relay-multi

部署自建中继用的脚本与说明，同样不随包分发，留在仓库里。
