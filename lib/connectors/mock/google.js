// DRY_RUN Google: nothing is booked or sent. `busy`, `events` and `emails` are exposed for tests.
export function createMockGoogle() {
  const busy = [];
  const events = [];
  const emails = [];
  return {
    busy,
    events,
    emails,
    async freeBusy() {
      return busy;
    },
    async createEvent(event) {
      const created = { id: `evtMOCK${events.length + 1}`, htmlLink: `https://calendar.example/evtMOCK${events.length + 1}`, ...event };
      events.push(created);
      return created;
    },
    async patchEvent(eventId, changes) {
      const event = events.find((e) => e.id === eventId);
      if (!event) throw new Error(`mock Google: no event ${eventId}`);
      return Object.assign(event, changes);
    },
    async sendEmail(email) {
      emails.push(email);
      return { id: `msgMOCK${emails.length}` };
    },
  };
}
