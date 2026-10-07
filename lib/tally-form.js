import { randomUUID } from 'node:crypto';
import { rules } from './rules.js';

const block = (type, groupType, payload, groupUuid = randomUUID()) => ({ uuid: randomUUID(), type, groupUuid, groupType, payload });
const question = (label) => block('TITLE', 'QUESTION', { html: label });
const input = (type) => block(type, type, { isRequired: true, placeholder: '' });

function dropdown(options) {
  const groupUuid = randomUUID();
  return options.map((text, index) =>
    block('DROPDOWN_OPTION', 'DROPDOWN', {
      index, isFirst: index === 0, isLast: index === options.length - 1, isRequired: true, text,
    }, groupUuid));
}

// "13:00" -> "1pm ET"
export function slotLabel(slot) {
  const hour = Number(slot.split(':')[0]);
  return `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'} ${rules.booking.slot_label}`;
}

// The step 0 form: 7 fields, no phone field, and the thank-you page. Everything comes from rules.json.
export function formBlocks() {
  const { labels, title, thank_you } = rules.form;
  const times = rules.booking.slots.map(slotLabel);
  const zones = Object.keys(rules.booking.buyer_timezones);
  return [
    block('FORM_TITLE', 'TEXT', { title, html: title }),
    block('TEXT', 'TEXT', { html: rules.disclaimer }),
    question(labels.name), input('INPUT_TEXT'),
    question(labels.email), input('INPUT_EMAIL'),
    question(labels.title), input('INPUT_TEXT'),
    question(labels.company), input('INPUT_TEXT'),
    question(labels.first_date), input('INPUT_DATE'),
    question(labels.first_time), ...dropdown(times),
    question(labels.timezone), ...dropdown(zones),
    block('PAGE_BREAK', 'PAGE_BREAK', { index: 0, isQualifiedForThankYouPage: true, isThankYouPage: true, isFirst: true, isLast: true }),
    block('HEADING_2', 'HEADING_2', { html: thank_you }),
  ];
}
