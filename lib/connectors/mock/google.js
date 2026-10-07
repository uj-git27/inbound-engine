// DRY_RUN Google: nothing is booked or sent. `busy`, `events` and `emails` are exposed for tests.
export function createMockGoogle() {
  const busy = [];
  const events = [];
  const emails = [];
  return {
    busy,
    events,
    emails,
    // Like the real calendar: a meeting that has been booked makes its time busy.
    async freeBusy() {
      return [...busy, ...events.map((e) => ({ start: e.start.dateTime, end: e.end.dateTime }))];
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
    cancelled: [],
    async deleteEvent(eventId) {
      const index = events.findIndex((e) => e.id === eventId);
      if (index < 0) throw new Error(`mock Google: no event ${eventId}`);
      this.cancelled.push(...events.splice(index, 1));
    },
    async sendEmail(email) {
      emails.push(email);
      return { id: `msgMOCK${emails.length}` };
    },
  };
}
