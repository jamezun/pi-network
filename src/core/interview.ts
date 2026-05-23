// Pi Network — Structured supervisor interview protocol
// Ported from pi-intercom's full interview system.
// Supports question types: single, multi, text, image, info
// Reply validation: single must match option, multi must be array of options, text/image are free-form

export interface InterviewQuestion {
  id: string;
  type: "single" | "multi" | "text" | "image" | "info";
  question: string;
  options?: unknown[];
  context?: string;
}

export interface InterviewRequest {
  title?: string;
  description?: string;
  questions: InterviewQuestion[];
}

export interface InterviewReply {
  responses: Array<{ id: string; value: unknown }>;
}

function optionLabel(opt: unknown): string {
  return typeof opt === "string" ? opt : (opt as { label: string }).label;
}

function exampleValue(q: InterviewQuestion): unknown {
  if (q.type === "multi") return q.options?.slice(0, 2).map(optionLabel) ?? [];
  if (q.type === "single") return q.options?.[0] !== undefined ? optionLabel(q.options[0]) : "option";
  if (q.type === "image") return "image description";
  return "answer text";
}

export function validateInterviewRequest(input: unknown): { ok: true; interview: InterviewRequest } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "interview must be an object with a questions array" };
  }
  const raw = input as Record<string, unknown>;
  if (raw.title !== undefined && typeof raw.title !== "string") return { ok: false, error: "interview.title must be a string" };
  if (raw.description !== undefined && typeof raw.description !== "string") return { ok: false, error: "interview.description must be a string" };
  if (!Array.isArray(raw.questions) || raw.questions.length === 0) return { ok: false, error: "interview.questions must be a non-empty array" };

  const validTypes = new Set(["single", "multi", "text", "image", "info"]);
  const ids = new Set<string>();
  const questions: InterviewQuestion[] = [];

  for (let i = 0; i < raw.questions.length; i++) {
    const q = raw.questions[i];
    if (!q || typeof q !== "object" || Array.isArray(q)) return { ok: false, error: `questions[${i}] must be an object` };
    const qRec = q as Record<string, unknown>;
    if (typeof qRec.id !== "string" || !qRec.id.trim()) return { ok: false, error: `questions[${i}].id must be a non-empty string` };
    const id = qRec.id.trim();
    if (ids.has(id)) return { ok: false, error: `duplicate question id: ${id}` };
    ids.add(id);
    if (typeof qRec.type !== "string" || !validTypes.has(qRec.type)) return { ok: false, error: `questions[${i}].type must be single|multi|text|image|info` };
    if (typeof qRec.question !== "string" || !qRec.question.trim()) return { ok: false, error: `questions[${i}].question must be a non-empty string` };

    let options: unknown[] | undefined;
    if (qRec.options !== undefined) {
      if (!Array.isArray(qRec.options)) return { ok: false, error: `questions[${i}].options must be an array` };
      options = [];
      for (let j = 0; j < qRec.options.length; j++) {
        const o = qRec.options[j];
        if (typeof o === "string") { if (!o.trim()) return { ok: false, error: `questions[${i}].options[${j}] must not be empty` }; options.push(o.trim()); }
        else if (o && typeof o === "object" && !Array.isArray(o) && typeof (o as { label?: unknown }).label === "string" && (o as { label: string }).label.trim()) options.push({ ...o, label: (o as { label: string }).label.trim() });
        else return { ok: false, error: `questions[${i}].options[${j}] must be a non-empty string or { label: string }` };
      }
    }
    if ((qRec.type === "single" || qRec.type === "multi") && (!options || !options.length)) return { ok: false, error: `questions[${i}].options required for ${qRec.type}` };
    if (qRec.type !== "single" && qRec.type !== "multi" && options) return { ok: false, error: `questions[${i}].options only valid for single/multi` };

    questions.push({ id, type: qRec.type as InterviewQuestion["type"], question: qRec.question.trim(), ...(options ? { options } : {}), ...(typeof qRec.context === "string" ? { context: qRec.context } : {}) });
  }

  return { ok: true, interview: { ...(typeof raw.title === "string" ? { title: raw.title.trim() } : {}), ...(typeof raw.description === "string" ? { description: raw.description.trim() } : {}), questions } };
}

export function formatInterviewRequest(interview: InterviewRequest, note?: string): string {
  const lines: string[] = [];
  if (interview.title?.trim()) lines.push(`Interview: ${interview.title.trim()}`);
  if (interview.description?.trim()) lines.push(interview.description!.trim());
  if (note?.trim()) lines.push(`Note: ${note.trim()}`);
  if (lines.length) lines.push("");
  lines.push("Questions:");
  interview.questions.forEach((q, i) => {
    lines.push(`${i + 1}. [${q.id}] (${q.type}) ${q.question}`);
    if (q.context?.trim()) lines.push(`   Context: ${q.context.trim()}`);
    if (q.options?.length) { lines.push("   Options:"); q.options.forEach(o => lines.push(`   - ${optionLabel(o)}`)); }
  });
  const example = { responses: interview.questions.filter(q => q.type !== "info").map(q => ({ id: q.id, value: exampleValue(q) })) };
  lines.push("", "Reply with JSON:", "```json", JSON.stringify(example, null, 2), "```");
  return lines.join("\n");
}

export function validateInterviewReply(value: unknown, interview: InterviewRequest): InterviewReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reply must be an object with a responses array");
  const responsesInput = (value as Record<string, unknown>).responses;
  if (!Array.isArray(responsesInput)) throw new Error("Reply must include a responses array");

  const questionById = new Map(interview.questions.filter(q => q.type !== "info").map(q => [q.id, q]));
  const seen = new Set<string>();
  const responses: InterviewReply["responses"] = [];

  for (let i = 0; i < responsesInput.length; i++) {
    const r = responsesInput[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`responses[${i}] must be an object`);
    const rec = r as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id.trim()) throw new Error(`responses[${i}].id required`);
    const id = rec.id.trim();
    const q = questionById.get(id);
    if (!q) throw new Error(`responses[${i}].id "${id}" not a valid question id`);
    if (seen.has(id)) throw new Error(`responses[${i}].id duplicated: ${id}`);
    seen.add(id);
    if (!Object.hasOwn(rec, "value")) throw new Error(`responses[${i}].value required`);

    if (q.type === "single") {
      if (typeof rec.value !== "string") throw new Error(`responses[${i}].value must be a string for single`);
      const labels = new Set(q.options?.map(optionLabel));
      if (!labels.has(rec.value.trim())) throw new Error(`responses[${i}].value "${rec.value}" not a valid option`);
      responses.push({ id, value: rec.value.trim() });
    } else if (q.type === "multi") {
      if (!Array.isArray(rec.value) || rec.value.some((v: unknown) => typeof v !== "string")) throw new Error(`responses[${i}].value must be string[] for multi`);
      const labels = new Set(q.options?.map(optionLabel));
      const sel = rec.value.map((v: string) => v.trim());
      const bad = sel.find((v: string) => !labels.has(v));
      if (bad) throw new Error(`responses[${i}].value "${bad}" not a valid option`);
      responses.push({ id, value: sel });
    } else {
      if (typeof rec.value !== "string") throw new Error(`responses[${i}].value must be a string for ${q.type}`);
      responses.push({ id, value: rec.value });
    }
  }
  return { responses };
}

export function parseInterviewReply(text: string, interview: InterviewRequest): { value?: InterviewReply; error?: string } | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return undefined;
  try { return { value: validateInterviewReply(JSON.parse(candidate), interview) }; }
  catch (e: any) { return { error: e.message }; }
}
