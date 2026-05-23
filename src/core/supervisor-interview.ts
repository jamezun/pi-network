// Pi Network — Supervisor interview protocol
// Phase 1.7: Structured interview questions for subagent → supervisor communication.

export interface SupervisorInterviewQuestion extends Record<string, unknown> {
  id: string;
  type: "single" | "multi" | "text" | "image" | "info";
  question: string;
  context?: string;
  options?: unknown[];
}

export interface SupervisorInterviewRequest extends Record<string, unknown> {
  title?: string;
  description?: string;
  questions: SupervisorInterviewQuestion[];
}

export interface SupervisorInterviewReply {
  responses: Array<{ id: string; value: unknown }>;
}

const VALID_TYPES = new Set(["single", "multi", "text", "image", "info"]);

export function validateSupervisorInterviewRequest(input: unknown):
  { ok: true; interview: SupervisorInterviewRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "interview must be an object with a questions array" };
  }

  const raw = input as Record<string, unknown>;
  if (raw.title !== undefined && typeof raw.title !== "string") {
    return { ok: false, error: "interview.title must be a string when provided" };
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return { ok: false, error: "interview.description must be a string when provided" };
  }
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) {
    return { ok: false, error: "interview.questions must be a non-empty array" };
  }

  const ids = new Set<string>();
  const questions: SupervisorInterviewQuestion[] = [];

  for (let i = 0; i < raw.questions.length; i++) {
    const qRaw = raw.questions[i];
    if (!qRaw || typeof qRaw !== "object" || Array.isArray(qRaw)) {
      return { ok: false, error: `interview.questions[${i}] must be an object` };
    }
    const q = qRaw as Record<string, unknown>;

    if (typeof q.id !== "string" || q.id.trim() === "") {
      return { ok: false, error: `interview.questions[${i}].id must be a non-empty string` };
    }
    const id = q.id.trim();
    if (ids.has(id)) return { ok: false, error: `interview question id must be unique: ${id}` };
    ids.add(id);

    if (typeof q.type !== "string" || !VALID_TYPES.has(q.type)) {
      return { ok: false, error: `interview.questions[${i}].type must be one of: single, multi, text, image, info` };
    }
    if (typeof q.question !== "string" || q.question.trim() === "") {
      return { ok: false, error: `interview.questions[${i}].question must be a non-empty string` };
    }

    let options: unknown[] | undefined;
    if (q.options !== undefined) {
      if (!Array.isArray(q.options)) {
        return { ok: false, error: `interview.questions[${i}].options must be an array when provided` };
      }
      options = [];
      for (let j = 0; j < q.options.length; j++) {
        const opt = q.options[j];
        if (typeof opt === "string") {
          if (!opt.trim()) return { ok: false, error: `interview.questions[${i}].options[${j}] must not be empty` };
          options.push(opt.trim());
        } else if (opt && typeof opt === "object" && !Array.isArray(opt) && typeof (opt as { label?: unknown }).label === "string") {
          const label = (opt as { label: string }).label;
          options.push({ ...(opt as Record<string, unknown>), label: label.trim() });
        } else {
          return { ok: false, error: `interview.questions[${i}].options[${j}] must be a non-empty string or { label }` };
        }
      }
    }

    if ((q.type === "single" || q.type === "multi") && (!options || options.length === 0)) {
      return { ok: false, error: `interview.questions[${i}].options required for ${q.type} questions` };
    }

    questions.push({
      ...q,
      id,
      type: q.type as SupervisorInterviewQuestion["type"],
      question: (q.question as string).trim(),
      ...(options ? { options } : {}),
    });
  }

  return {
    ok: true,
    interview: {
      ...raw,
      ...(typeof raw.title === "string" ? { title: raw.title.trim() } : {}),
      ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}),
      questions,
    },
  };
}

export function validateSupervisorInterviewReply(input: unknown):
  { ok: true; reply: SupervisorInterviewReply } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Reply must be an object with a responses array" };
  }

  const raw = input as Record<string, unknown>;
  if (!Array.isArray(raw.responses)) {
    return { ok: false, error: "responses must be an array" };
  }

  const responses: Array<{ id: string; value: unknown }> = [];
  for (let i = 0; i < raw.responses.length; i++) {
    const r = raw.responses[i];
    if (!r || typeof r !== "object" || typeof (r as any).id !== "string") {
      return { ok: false, error: `responses[${i}] must have a string id` };
    }
    responses.push({ id: (r as any).id, value: (r as any).value });
  }

  return { ok: true, reply: { responses } };
}

export function formatInterviewPrompt(interview: SupervisorInterviewRequest): string {
  const lines: string[] = [];
  if (interview.title) lines.push(`## ${interview.title}`);
  if (interview.description) lines.push(interview.description);
  lines.push("");

  for (const q of interview.questions) {
    if (q.type === "info") {
      lines.push(`ℹ️ ${q.question}`);
    } else if (q.type === "single" && q.options) {
      lines.push(`❓ ${q.question}`);
      for (const opt of q.options) {
        const label = typeof opt === "string" ? opt : (opt as any).label;
        lines.push(`  - ${label}`);
      }
      lines.push("  (pick one)");
    } else if (q.type === "multi" && q.options) {
      lines.push(`❓ ${q.question} (pick any)`);
      for (const opt of q.options) {
        const label = typeof opt === "string" ? opt : (opt as any).label;
        lines.push(`  - ${label}`);
      }
    } else if (q.type === "text") {
      lines.push(`❓ ${q.question}`);
      lines.push("  (free text response)");
    } else {
      lines.push(`❓ ${q.question}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
