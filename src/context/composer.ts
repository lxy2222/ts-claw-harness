import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Role, type Message } from "../types/message";
import { SkillLoader } from "./skill";

const MINIMAL_CORE_PROMPT = `# 核心身份
你名叫 ts-tiny-claw，一个由驾驭工程驱动的骨灰级研发助手。
你具备极简主义哲学，拒绝废话。你能通过系统提供的内置工具，创建、读取、修改和执行工作区中的代码。

# 核心纪律 (CRITICAL)
1. 如需检查文件是否存在，请使用 bash 的 ls 或 test -f，而不是对目录使用 read_file。
2. 创建新文件时，务必使用 write_file，并同时提供 path 和 content 参数。
3. 编辑文件前务必先读取现有文件，以理解上下文。
4. 无论何时你需要写代码或创建文件，都要直接使用 write_file 或 edit_file 工具。
5. 同一批返回的多个工具调用会并发执行，彼此没有先后顺序保证；严禁在同一轮并发调用中对同一文件同时读写或多次写入，有先后依赖的操作必须分轮执行。
6. 遇到工具执行报错时，仔细阅读 stderr，尝试自己修正命令并重试。
7. 始终用中文回复，以便传达你的进展和想法。
`;

/**
 * PromptComposer 负责根据工作区环境动态生成 System Prompt
 */
export class PromptComposer {
  private readonly skillLoader: SkillLoader;

  constructor(private readonly workDir: string) {
    this.skillLoader = new SkillLoader(workDir);
  }

  /**
   * 组装并返回一条完整的 Role.System 消息
   */
  build(): Message {
    const sections: string[] = [MINIMAL_CORE_PROMPT];

    // 2. 外部化状态：加载项目专属规范 (AGENTS.md)
    const agentsMDPath = path.join(this.workDir, "AGENTS.md");
    if (existsSync(agentsMDPath) && statSync(agentsMDPath).isFile()) {
      try {
        const content = readFileSync(agentsMDPath, "utf8").trim();
        if (content) {
          sections.push(
            [
              "# 项目专属指南 (来自 AGENTS.md)",
              "以下是当前工作区特有的架构规范与注意事项，你的行为必须绝对符合以下要求：",
              "```markdown",
              content,
              "```",
              "",
            ].join("\n"),
          );
        }
      } catch {
        // 读取 AGENTS.md 失败时静默跳过，保证引擎仍能以极简内核启动
      }
    }

    // 3. 动态加载技能外挂 (Skills)
    const skillsContent = this.skillLoader.loadAll();
    if (skillsContent !== "") {
      sections.push(skillsContent);
    }

    return {
      role: Role.System,
      content: sections.join("\n"),
    };
  }
}
