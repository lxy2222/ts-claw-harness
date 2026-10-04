## 本项目为了实现一个最小的tiny-ts-claw-harness
1. 包含的架构如下

### 入口交互层
用cli调用，支持接入飞书，实现human-in-loop

### 核心引擎层
main.ts 用来控制ReAct循环,新增Thinking强制大模型慢下来思考 会有一个provider

### 上下文工程
1. prompt动态组装 - 读AGENTS.md
2. token监控 
3. 运行时事件注入 - 模型在做决策注入指令

### 基于文件系统的状态和记忆
这个把进度写在todo/memory

### 工具与执行层
用来执行命令 包含工具 read/write/edit/bash
middleware 用来审批