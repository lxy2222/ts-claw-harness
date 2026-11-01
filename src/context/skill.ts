import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Skill 定义了从 SKILL.md 中解析出的标准化技能结构
 */
export interface Skill {
  name: string;
  description: string;
  /** Markdown 正文指令 */
  body: string;
}

/**
 * SkillLoader 负责从本地文件系统中加载并解析符合规范的技能模板
 */
export class SkillLoader {
  constructor(private readonly workDir: string) {}

  /**
   * 扫描技能目录（优先工作区 .claw/skills -> 工作区 .cursor/skills -> 全局 ~/.cursor/skills），
   * 解析所有 SKILL.md，并格式化为字符串准备注入 Context
   */
  loadAll(): string {
    const candidateDirs = [
      path.join(this.workDir, ".claw", "skills"),
      path.join(this.workDir, ".cursor", "skills"),
      path.join(os.homedir(), ".cursor", "skills"),
    ];

    let skillFiles: string[] = [];
    for (const dir of candidateDirs) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        continue;
      }
      try {
        const found: string[] = [];
        this.walkSkillFiles(dir, found);
        if (found.length > 0) {
          console.log(`[SkillLoader] 从 ${dir} 加载了 ${found.length} 个技能文件`);
          skillFiles = found;
          break;
        }
      } catch {
        // 当前候选目录读取异常时继续尝试下一个回退目录
      }
    }

    if (skillFiles.length === 0) {
      return "";
    }

    const sections: string[] = [];
    for (const filePath of skillFiles) {
      try {
        const content = readFileSync(filePath, "utf8");
        const skill = parseSkillMD(content);
        sections.push(
          [
            `#### 技能名称: ${skill.name}`,
            `**触发条件**: ${skill.description}`,
            "",
            "**执行指南**:",
            skill.body,
            "",
            "---",
          ].join("\n"),
        );
      } catch {
        // 单个文件读取失败时跳过，不影响其他技能加载
      }
    }

    if (sections.length === 0) {
      return "";
    }

    const header = [
      "",
      "### 可用专业技能 (Agent Skills)",
      "以下是你拥有的标准化外挂技能，请在符合 description 描述的场景下严格遵循其正文指令：",
      "",
    ].join("\n");

    return `${header}\n${sections.join("\n")}\n`;
  }

  /**
   * 递归遍历目录，收集所有名为 SKILL.md 的文件路径（等价于 Go 的 filepath.WalkDir）
   */
  private walkSkillFiles(dir: string, result: string[]): void {
    const entries = readdirSync(dir, { withFileTypes: true });
    // 按名称排序，保证跨平台顺序一致（有利于大模型 Prefix Cache 命中）
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // 使用 statSync 跟随软链接（~/.cursor/skills 下常有指向 ~/.agents/skills 的 symlink）
      let info: ReturnType<typeof statSync>;
      try {
        info = statSync(fullPath);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        this.walkSkillFiles(fullPath, result);
      } else if (info.isFile() && entry.name === "SKILL.md") {
        result.push(fullPath);
      }
    }
  }
}

/**
 * 极简解析带有 YAML Frontmatter 的 Markdown 内容
 */
export function parseSkillMD(content: string): Skill {
  const skill: Skill = {
    name: "Unknown Skill",
    description: "No description provided.",
    body: content, // 默认将全量内容作为 body
  };

  // 简单解析 YAML Frontmatter (以 --- 包裹)
  if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
    const firstCloseIdx = content.indexOf("---", 3);
    if (firstCloseIdx !== -1) {
      const frontmatter = content.slice(3, firstCloseIdx);
      skill.body = content.slice(firstCloseIdx + 3).trim();

      // 逐行提取 metadata
      const lines = frontmatter.split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith("name:")) {
          skill.name = line.slice("name:".length).trim();
        } else if (line.startsWith("description:")) {
          skill.description = line.slice("description:".length).trim();
        }
      }
    }
  }

  return skill;
}
