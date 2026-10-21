# x2 Robot Viewer

基于 [fan-ziqi/robot_viewer](https://github.com/fan-ziqi/robot_viewer) 改造的 x2 整机 URDF 查看器，通过只读 ROS1 状态话题显示左右臂关节姿态。

## Fork 来源与致谢

本项目 Fork 自原作者 **范子琦（[fan-ziqi](https://github.com/fan-ziqi)）** 的开源项目 **[robot_viewer](https://github.com/fan-ziqi/robot_viewer)**。原始网页查看器及其基础功能由上游作者开发，感谢作者的开源贡献。

本分支在上游基础上增加 x2 整机模型、ROS1 只读话题订阅、双臂关节角度映射、实时状态展示及机器人部署工具。保留上游 [Apache-2.0 许可证](LICENSE)、页面署名与 [原始 README](README_UPSTREAM.md)。

## 当前功能

- 显示完整 x2 整机；左右臂各六个旋转关节接入实际反馈。
- `/joint_information`、`/joint_information2` 分别映射到 `left_joint1..6`、`right_joint1..6`。
- 角度/弧度、数据新鲜度、接收频率、左右臂切换、暂停/继续。
- 支持本地合成数据演示，以及在宿主机通过现有 Docker 容器只读订阅 ROS。
- 含原始模型、新生成的双臂模型、生成脚本和几何处理记录。

**当前安装关系按 STL 支座对齐，尚未经实机标定。头部的偏航/俯仰关系还没有加入 URDF。相机外参与手眼标定尚未实现。**

## 本地开发

需要 Node.js、pnpm 和 Python 3：

```bash
pnpm install
node scripts/dev-local.mjs
```

打开 `http://127.0.0.1:3000/`。本地使用合成演示数据，页面有明确标记。

本次从机器人取回的 `dist/` 已在本地保留，可直接预览当前构建版本：

```bash
python3 server/ros_stream.py --demo --port 8766
```

打开 `http://127.0.0.1:8766/`。`dist/` 不纳入 Git；其他人克隆仓库后先执行下列构建步骤。

## 构建

```bash
node node_modules/vite/bin/vite.js build
python3 scripts/package_runtime.py
```

生成的运行压缩包供机器人部署使用，无需把 node_modules 上传到机器人。

## ROS 实机读取

在已部署的机器人宿主机项目目录运行：

```bash
bash 启动网页.sh
```

默认读取容器 `turtle2_release` 内的已有话题，仅创建状态订阅节点。头部、机械臂及 CAN 控制程序由操作者启动。

配置位于 `config/ros-topics.json`。更多运行和部署说明见 [本地开发说明](本地开发说明.md)。

## 模型来源与重新生成

- `public/robots/x2/x2.urdf`：开发包原始整机 URDF。
- `public/robots/x2/x2-live.urdf`：接入双臂关节后的整机 URDF。
- `public/robots/x2/meshes/`：原始与拆分网格，含 R5 网格。
- `config/R5a-source.urdf`：从机器人已有工作空间只读取得的 R5 关节模型。
- `config/x2-arm-mounts.json`：待实机校验的双臂安装变换。
- `config/x2-model-audit.json`：网格处理和参数来源记录。

仅在修改模型时需要 numpy/scipy，日常网页运行不需要：

```bash
python3 -m pip install numpy scipy
python3 scripts/build_x2_articulated.py
```

模型生成脚本只使用本仓库中的资源，不依赖仓库外的原开发包目录。生成后需要重新构建前端。

## Git

本目录是独立仓库，可配置你自己的远程仓库。`node_modules/`、`dist/`、运行日志、进程文件、环境文件和部署包均已忽略。代码与模型需要提交到 Git。

## 许可与上游

查看器源于 fan-ziqi/robot_viewer，保留 Apache-2.0 [LICENSE](LICENSE) 和原作者页面署名，上游说明保存在 [README_UPSTREAM.md](README_UPSTREAM.md)。新增部分包括 ROS 状态读取、关节映射、整机模型重建及其配置。机器人模型来自用户提供的开发包及机器人现有模型；模型素材的使用授权应遵循其提供方约定。
