import { http } from '../http.js';
import { need } from '../env.js';

export function companyProfilePrompt(domain) {
  return [
    `Use Google Search to research the company whose website is ${domain}. Never answer from memory.`,
    'Return only JSON with this shape:',
    '{"headcount_min": number|null, "headcount_max": number|null, "hq_country": string|null, "industry": string|null,',
    ' "sells_to_businesses": boolean|null, "latest_funding_stage": string|null, "latest_funding_date": "YYYY-MM-DD"|null,',
    ' "parent_company": {"name": string, "domain": string}|null, "subsidiaries": [{"name": string, "domain": string}],',
    ' "evidence": {"<field name>": {"source_url": string, "quote": string}}}',
    'Every field you fill needs an entry in "evidence" with the source_url of a search result and a short quote from it.',
    'If a search result does not support a field, set it to null.',
  ].join('\n');
}

export function createGemini(env = process.env) {
  return {
    // One call with search on, temperature 0. Returns the raw API response.
    async generate(prompt, { jsonMode = true, timeoutMs } = {}) {
      const model = need('GEMINI_MODEL', env);
      const generationConfig = { temperature: 0 };
      if (jsonMode) generationConfig.responseMimeType = 'application/json';
      const res = await http(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': need('GEMINI_API_KEY', env) },
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }],
          generationConfig,
        },
        timeoutMs,
      });
      return res.json;
    },
  };
}

export function groundingSources(response) {
  const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return chunks.filter((c) => c.web?.uri).map((c) => ({ uri: c.web.uri, title: c.web.title ?? '' }));
}

export function responseText(response) {
  return (response?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}
