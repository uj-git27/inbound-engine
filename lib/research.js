// Step 4 signals: Exa news, the person match and the Firecrawl pricing page.
// The live versions are built in phase 3. Until then every signal is "unknown", which adds no
// points (billing model and why-now are add-only) and makes no paid call.
export function createResearch() {
  return {
    built: false,
    async pricing() {
      return { model: 'unknown', quote: null, url: null };
    },
    async news() {
      return [];
    },
    async person() {
      return null;
    },
  };
}
