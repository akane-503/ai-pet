# 第三方来源与许可

本仓库公开可见，尚未选择本项目新增代码的开源许可。`UNLICENSED` 表明本项目没有授予开源许可，不取消已有第三方许可证。

## 参考的桌宠实现

原版鲸鱼挂件、气泡几何与交互实现参考 [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)。上游代码为 MIT，完整许可保留如下。上游 [PROVENANCE.md](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/main/PROVENANCE.md) 区分代码与素材：图片、GIF、音效、图标不包含在 MIT 许可内，上游不为这些素材授予再许可。

```text
MIT License

Copyright (c) 2026 MeteorNOX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 角色与音效

图片包括鲸鱼挂件原素材、娘化设定参考图的裁切及基于参考图生成的图片。详细来源见 [角色来源](assets/characters/CREDITS.md)。公开分发授权待核实，本项目不授予这些素材的再许可，也不承诺可再分发或商用。品牌名称与标志属于各自权利人；本项目为非官方工具。

## npm 依赖

Electron、Koffi 及传递依赖由 `npm ci` 安装，版本、完整性与许可证标识记录在 `package-lock.json`。各依赖许可证随其 npm 包提供；Electron 运行时的 `LICENSE` 和 `LICENSES.chromium.html` 由安装程序保留。轻量压缩包不捆绑这些依赖。
