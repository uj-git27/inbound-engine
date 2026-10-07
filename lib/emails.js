import { rules } from './rules.js';
import { customerStory } from './brief.js';

const firstName = (lead) => String(lead.name ?? '').trim().split(/\s+/)[0] || 'there';

// Template drafts. Nothing is sent until a person approves it with a signed link.
// In DEMO_MODE every email goes to DEMO_INBOX.
export const recipient = (lead, env = process.env) => (env.DEMO_MODE === 'true' ? (env.DEMO_INBOX || lead.email) : lead.email);

export function preDemoEmail(lead, outcome, booking) {
  const story = customerStory(outcome.profile, outcome.pricing);
  const pricing = outcome.pricing?.quote ? `I had a look at your pricing page ("${outcome.pricing.quote}"), so we can make the demo specific to how you bill.` : 'We can make the demo specific to how you bill today.';
  return {
    subject: `Ahead of our demo${booking?.slot ? ` on ${booking.slot}` : ''}`,
    text: [
      `Hi ${firstName(lead)},`,
      `Thanks for booking time with us${booking?.buyerLocal ? ` (${booking.buyerLocal} your time)` : ''}.`,
      pricing,
      `I'll also bring the ${story.story} story, which is the closest match to your setup.`,
      'If there is one thing you want to see, reply and I will build the demo around it.',
      rules.emails.sender_name,
      rules.disclaimer,
    ].join('\n\n'),
  };
}

export function rejectionEmail(lead) {
  return {
    subject: 'Your demo request',
    text: [
      `Hi ${firstName(lead)},`,
      "Thanks for your interest. From what you shared, a live demo isn't the best next step right now, so we haven't booked a meeting.",
      `You can see the product at your own pace here: ${rules.emails.product_tour_url}`,
      'If your situation changes, reply to this email and we will pick it up.',
      rules.emails.sender_name,
      rules.disclaimer,
    ].join('\n\n'),
  };
}
