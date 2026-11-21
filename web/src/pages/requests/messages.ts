import { asList as arr, asObject as obj, asString as s, type JsonObject as J } from "./json";

export type Block = {
  role: "System" | "User" | "Assistant" | "Tool result" | "Reasoning";
  text: string;
  code?: boolean;
  note?: string;
};

export type Parsed = { blocks: Block[]; tools: string[] };

const json = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "");

function call(name: string, args: unknown): string {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return `${name}(${a})`;
    }
  }
  const one = JSON.stringify(a ?? {});
  return one.length <= 80 ? `${name}(${one.replace(/":/g, '": ').replace(/,"/g, ', "')})` : `${name}(${JSON.stringify(a, null, 2)})`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((p) => {
      const o = obj(p);
      if (!o) return "";
      if (typeof o.text === "string") return o.text;
      const t = s(o.type);
      if (t.includes("image")) return "[image]";
      if (t.includes("audio")) return "[audio]";
      if (t.includes("file") || t === "document") return "[file]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function push(out: Block[], b: Block) {
  if (b.text.trim() !== "") out.push(b);
}

const role = (r: string): Block["role"] =>
  r === "system" || r === "developer" ? "System" : r === "assistant" || r === "model" ? "Assistant" : r === "tool" || r === "function" ? "Tool result" : "User";

function openAIChatMessage(m: J, out: Block[]) {
  const r = role(s(m.role));
  if (m.reasoning_content) push(out, { role: "Reasoning", text: s(m.reasoning_content) });
  push(out, { role: r, text: textOf(m.content), code: r === "Tool result" });
  for (const tc of arr(m.tool_calls)) {
    const f = obj(obj(tc)?.function);
    if (f) push(out, { role: "Assistant", text: call(s(f.name), f.arguments), code: true, note: "tool call" });
  }
}

function anthropicBlocks(r: Block["role"], content: unknown, out: Block[]) {
  if (typeof content === "string") return push(out, { role: r, text: content });
  for (const b of arr(content)) {
    const o = obj(b);
    if (!o) continue;
    switch (o.type) {
      case "text":
        push(out, { role: r, text: s(o.text) });
        break;
      case "thinking":
        push(out, { role: "Reasoning", text: s(o.thinking) });
        break;
      case "tool_use":
        push(out, { role: "Assistant", text: call(s(o.name), o.input), code: true, note: "tool call" });
        break;
      case "tool_result":
        push(out, { role: "Tool result", text: textOf(o.content) || json(o.content), code: true });
        break;
      case "image":
        push(out, { role: r, text: "[image]" });
        break;
    }
  }
}

function responsesItems(items: unknown, out: Block[]) {
  if (typeof items === "string") return push(out, { role: "User", text: items });
  for (const it of arr(items)) {
    const o = obj(it);
    if (!o) continue;
    const t = s(o.type);
    if (t === "function_call") push(out, { role: "Assistant", text: call(s(o.name), o.arguments), code: true, note: "tool call" });
    else if (t === "function_call_output") push(out, { role: "Tool result", text: json(o.output), code: true });
    else if (t === "reasoning") push(out, { role: "Reasoning", text: arr(o.summary).map((x) => s(obj(x)?.text)).join("\n") });
    else if (t === "message" || o.role) push(out, { role: role(s(o.role)), text: textOf(o.content) });
  }
}

function geminiParts(r: Block["role"], parts: unknown, out: Block[]) {
  for (const p of arr(parts)) {
    const o = obj(p);
    if (!o) continue;
    if (typeof o.text === "string") push(out, { role: o.thought ? "Reasoning" : r, text: o.text });
    else if (obj(o.functionCall)) push(out, { role: "Assistant", text: call(s(obj(o.functionCall)!.name), obj(o.functionCall)!.args), code: true, note: "tool call" });
    else if (obj(o.functionResponse)) push(out, { role: "Tool result", text: json(obj(o.functionResponse)!.response), code: true });
    else if (obj(o.inlineData) || obj(o.fileData)) push(out, { role: r, text: "[file]" });
  }
}

export function parseRequest(shape: string, body: unknown): Parsed | undefined {
  const b = obj(body);
  if (!b) return undefined;
  const out: Block[] = [];
  let tools: string[] = [];
  switch (shape) {
    case "openai-chat":
      tools = arr(b.tools).map((t) => s(obj(obj(t)?.function)?.name) || s(obj(t)?.name));
      for (const m of arr(b.messages)) if (obj(m)) openAIChatMessage(obj(m)!, out);
      break;
    case "anthropic-messages":
      tools = arr(b.tools).map((t) => s(obj(t)?.name));
      if (b.system) push(out, { role: "System", text: textOf(b.system) });
      for (const m of arr(b.messages)) {
        const o = obj(m);
        if (o) anthropicBlocks(role(s(o.role)), o.content, out);
      }
      break;
    case "openai-responses":
      tools = arr(b.tools).map((t) => s(obj(t)?.name) || s(obj(t)?.type));
      if (b.instructions) push(out, { role: "System", text: s(b.instructions) });
      responsesItems(b.input, out);
      break;
    case "gemini": {
      tools = arr(b.tools).flatMap((t) => arr(obj(t)?.functionDeclarations).map((f) => s(obj(f)?.name)));
      const sys = obj(b.systemInstruction ?? b.system_instruction);
      if (sys) geminiParts("System", sys.parts, out);
      for (const c of arr(b.contents)) {
        const o = obj(c);
        if (o) geminiParts(role(s(o.role)), o.parts, out);
      }
      break;
    }
    default:
      return undefined;
  }
  if (out.length === 0 && tools.length === 0) return undefined;
  return { blocks: out, tools: tools.filter(Boolean) };
}

function joinEvents(shape: string, events: unknown[]): unknown {
  if (shape === "openai-responses") {
    for (const e of events) {
      const r = obj(obj(e)?.response);
      if (obj(e)?.type === "response.completed" && r) return r;
    }
    const text = events.map((e) => (obj(e)?.type === "response.output_text.delta" ? s(obj(e)?.delta) : "")).join("");
    return { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] };
  }
  if (shape === "anthropic-messages") {
    const blocks: J[] = [];
    for (const e of events) {
      const o = obj(e);
      if (!o) continue;
      if (o.type === "content_block_start") blocks[Number(o.index ?? blocks.length)] = { ...obj(o.content_block) };
      if (o.type === "content_block_delta") {
        const b = blocks[Number(o.index ?? 0)] ?? (blocks[Number(o.index ?? 0)] = { type: "text", text: "" });
        const d = obj(o.delta) ?? {};
        if (d.type === "text_delta") b.text = s(b.text) + s(d.text);
        if (d.type === "thinking_delta") b.thinking = s(b.thinking) + s(d.thinking);
        if (d.type === "input_json_delta") b.partial = s(b.partial) + s(d.partial_json);
      }
    }
    for (const b of blocks) {
      if (b && b.type === "tool_use" && typeof b.partial === "string") {
        try {
          b.input = JSON.parse(b.partial || "{}");
        } catch {
          b.input = b.partial;
        }
      }
    }
    return { content: blocks.filter(Boolean) };
  }
  if (shape === "gemini") {
    return { candidates: [{ content: { role: "model", parts: events.flatMap((e) => arr(obj(obj(arr(obj(e)?.candidates)[0])?.content)?.parts)) } }] };
  }
  return undefined;
}

export function parseResponse(shape: string, body: unknown): Parsed | undefined {
  let b: unknown = body;
  if (Array.isArray(b)) b = joinEvents(shape, b);
  const o = obj(b);
  if (!o) return typeof body === "string" && body ? { blocks: [{ role: "Assistant", text: body, code: true }], tools: [] } : undefined;
  const out: Block[] = [];
  if (obj(o.error)) {
    push(out, { role: "Assistant", text: json(o.error), code: true, note: "error" });
    return { blocks: out, tools: [] };
  }
  switch (shape) {
    case "openai-chat": {
      const m = obj(obj(arr(o.choices)[0])?.message);
      if (m) openAIChatMessage({ ...m, role: "assistant" }, out);
      break;
    }
    case "anthropic-messages":
      anthropicBlocks("Assistant", o.content, out);
      break;
    case "openai-responses":
      responsesItems(o.output, out);
      break;
    case "gemini":
      geminiParts("Assistant", obj(obj(arr(o.candidates)[0])?.content)?.parts, out);
      break;
    default:
      return undefined;
  }
  return out.length ? { blocks: out, tools: [] } : undefined;
}
