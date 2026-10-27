/**
 * A compact, curated emoji set for page and callout icons. The group names
 * are messages; the search keywords beside each emoji stay English for now.
 */

import type { MessageKey } from './i18n';

export type EmojiGroup = 'objects' | 'symbols' | 'nature' | 'people' | 'places' | 'food';
/** Each group's name, as a message: `t(EMOJI_GROUP_LABELS[id])`. */
export const EMOJI_GROUP_LABELS = {
  objects: 'onboarding.iconPicker.emojiGroups.objects',
  symbols: 'onboarding.iconPicker.emojiGroups.symbols',
  nature: 'onboarding.iconPicker.emojiGroups.nature',
  people: 'onboarding.iconPicker.emojiGroups.people',
  places: 'onboarding.iconPicker.emojiGroups.places',
  food: 'onboarding.iconPicker.emojiGroups.food',
} as const satisfies Record<EmojiGroup, MessageKey>;

const RAW: Record<EmojiGroup, string> = {
  objects: `📄 page document|📝 memo note write|📓 notebook|📔 journal|📒 ledger|📕 book red|📗 book green|📘 book blue|📚 books library|🗂️ dividers index|📁 folder|📂 open folder|🗃️ card box archive|🗄️ cabinet|📋 clipboard|📌 pin|📎 paperclip|✏️ pencil|🖊️ pen|🖋️ fountain pen|🖍️ crayon|📐 ruler triangle|📏 ruler|✂️ scissors|🔖 bookmark|🏷️ label tag|💼 briefcase work|🧾 receipt|📦 package box|🗓️ calendar schedule|📅 date|⏰ alarm clock|⌛ hourglass time|💡 idea bulb light|🔦 flashlight|🔑 key|🔒 lock private|🔓 unlocked|🧰 toolbox|🛠️ tools build|⚙️ gear settings|🧪 test lab|🔬 microscope research|🔭 telescope|📡 satellite|💻 laptop code|🖥️ desktop computer|⌨️ keyboard|🖱️ mouse|📱 phone mobile|📷 camera photo|🎥 film video|🎧 headphones music|🎙️ microphone podcast|📻 radio|📺 tv|💾 floppy save|💿 disc|🧭 compass|🗺️ map|🧳 luggage travel|🎁 gift|🎈 balloon|🎉 party celebrate|🏆 trophy win|🥇 medal first|🎯 target goal|🧩 puzzle|🎲 dice game|♟️ chess strategy|🎨 art palette design|🎭 theater|🎬 clapper movie|🎵 music note|🎸 guitar|🎹 piano|📊 chart bar stats|📈 chart up growth|📉 chart down|💰 money bag|💵 dollar cash|💳 card payment|🏦 bank|🛒 cart shopping|🧮 abacus math|📣 megaphone announce|🔔 bell notification|✉️ envelope mail|📬 mailbox inbox|📮 postbox|🗞️ newspaper|📰 news|🔗 link chain|🧲 magnet`,
  symbols: `⭐ star|🌟 glowing star|✨ sparkles|🔥 fire hot|⚡ lightning fast|💥 boom|❤️ heart love|🖤 black heart|🤍 white heart|💬 speech chat|💭 thought bubble|❓ question|❗ exclamation important|⚠️ warning|🚫 prohibited no|✅ check done|☑️ checkbox|✔️ checkmark|❌ cross wrong|➕ plus add|➖ minus|➗ divide|♾️ infinity|🔁 repeat loop|🔄 refresh sync|▶️ play|⏸️ pause|⏹️ stop|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|⬛ black square|⬜ white square|🔺 triangle up|🔻 triangle down|💠 diamond|🔷 blue diamond|🆕 new|🆗 ok|🔝 top|🏁 finish flag|🚩 flag red|📍 location pin|🧷 safety pin|☯️ yin yang balance|☮️ peace|♻️ recycle`,
  nature: `🌱 seedling grow|🌿 herb|🍀 clover luck|🌵 cactus|🌲 tree evergreen|🌳 tree|🌴 palm|🍁 maple leaf|🍂 leaves fall|🌸 blossom|🌻 sunflower|🌹 rose|🌷 tulip|🌼 flower|🍄 mushroom|🌍 earth globe world|🌙 moon night|☀️ sun|⛅ cloud sun|🌧️ rain|❄️ snow cold|🌈 rainbow|🌊 wave ocean|⛰️ mountain|🏔️ snow mountain|🏝️ island|🐶 dog|🐱 cat|🦊 fox|🐻 bear|🐼 panda|🦁 lion|🐯 tiger|🐸 frog|🐵 monkey|🦉 owl wisdom|🐝 bee busy|🦋 butterfly|🐢 turtle slow|🐙 octopus|🐳 whale|🐬 dolphin|🦄 unicorn`,
  people: `😀 smile happy|😄 grin|😊 blush|😎 cool|🤓 nerd|🤔 thinking|😴 sleep|🥳 party|😅 sweat|😌 relieved calm|🙂 slight smile|🙃 upside down|😐 neutral|🤯 mind blown|🥲 tear smile|😤 determined|🫡 salute|👋 wave hello|👍 thumbs up|👎 thumbs down|👏 clap|🙌 raised hands|🙏 pray thanks|💪 muscle strong|✍️ writing|👀 eyes look|🧠 brain think|🫶 heart hands|🤝 handshake deal|👤 person user|👥 people team|🧑‍💻 developer|🧑‍🎨 artist|🧑‍🏫 teacher|🧑‍🔬 scientist|🧘 meditate|🏃 run|🚶 walk`,
  places: `🏠 home house|🏡 garden house|🏢 office building|🏫 school|🏥 hospital|🏛️ museum|⛪ church|🏰 castle|🗼 tower|🗽 statue|⛺ tent camp|🚀 rocket launch|✈️ plane travel|🚗 car|🚲 bike|🚂 train|⛵ sailboat|⚓ anchor|🛸 ufo|🌆 city|🌉 bridge|🏖️ beach vacation`,
  food: `☕ coffee|🍵 tea|🥤 drink|🍺 beer|🍷 wine|🍎 apple|🍋 lemon|🍓 strawberry|🍑 peach|🥑 avocado|🥕 carrot|🍞 bread|🧀 cheese|🍕 pizza|🍔 burger|🌮 taco|🍣 sushi|🍜 noodles ramen|🍪 cookie|🍰 cake|🍫 chocolate|🍿 popcorn|🍳 cooking egg|🥗 salad healthy`,
};

export interface EmojiEntry {
  emoji: string;
  keywords: string;
}

export const EMOJI_GROUPS: { id: EmojiGroup; items: EmojiEntry[] }[] = (Object.entries(RAW) as [EmojiGroup, string][]).map(([id, list]) => ({
  id,
  items: list.split('|').map((entry) => {
    const space = entry.indexOf(' ');
    return { emoji: entry.slice(0, space), keywords: entry.slice(space + 1) };
  }),
}));

export const ALL_EMOJI: EmojiEntry[] = EMOJI_GROUPS.flatMap((g) => g.items);

export function randomEmoji(): string {
  const pool = EMOJI_GROUPS[0].items.concat(EMOJI_GROUPS[2].items);
  return pool[Math.floor(Math.random() * pool.length)].emoji;
}
