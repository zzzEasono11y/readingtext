# 离线字体

以下字体以未经修改的原始文件随阅读器分发，均使用 SIL Open Font License 1.1。版权归各字体作者所有；完整版权声明和授权文本保存在对应许可证文件中，构建时一并打包。项目自身的 MIT 授权不替代字体授权。

| 阅读器名称 | 官方版本 | 文件 | 许可证 |
| --- | --- | --- | --- |
| 思源宋体 | [2.003R](https://github.com/adobe-fonts/source-han-serif/releases/tag/2.003R) | SourceHanSerifCN-Regular.otf | SourceHanSerif-LICENSE.txt |
| 思源黑体 | [2.005R](https://github.com/adobe-fonts/source-han-sans/releases/tag/2.005R) | SourceHanSansCN-Regular.otf | SourceHanSans-LICENSE.txt |
| 霞鹜文楷屏幕阅读版 | [v1.522](https://github.com/lxgw/LxgwWenKai-Screen/releases/tag/v1.522) | LXGWWenKaiScreen.ttf | LXGWWenKaiScreen-OFL.txt |

思源字体使用简体中文地区的常规字重版本，文楷使用屏幕阅读版。字体选择只影响书籍正文，不改变界面字体。字体文件总计约 44 MiB，会增加程序体积；阅读时通过本地协议按需加载，不连接字体服务。

原始下载地址及 SHA-256 校验值见 `manifest.json`。许可证分别来自同一官方版本的根目录 `LICENSE.txt` / `OFL.txt`。如以后升级字体，请同时更新版本、文件、许可证和校验值，再运行字体完整性测试和桌面字体加载测试。
