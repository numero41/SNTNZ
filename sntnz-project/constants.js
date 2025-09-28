// ============================================================================
// constants.js
// ----------------------------------------------------------------------------
// Shared configuration for server and client. Server imports this file directly,
// and also exposes its JSON form at GET /config so the client can fetch it.
// ============================================================================

// constants.js

// Check the environment. Default to 'development' if NODE_ENV is not set.
const isProduction = process.env.NODE_ENV === 'production';

const ROUND_DURATION_SECONDS_PROD = 60;
const CHAPTER_DURATION_MINUTES_PROD = 360;

const ROUND_DURATION_SECONDS_DEV = 120;
const CHAPTER_DURATION_MINUTES_DEV = 10;

// --- Dynamically Calculate Values Before Exporting ---
const CHAPTER_DURATION_MINUTES = isProduction ? CHAPTER_DURATION_MINUTES_PROD : CHAPTER_DURATION_MINUTES_DEV;

let HISTORY_CHAPTER_SCHEDULE_CRON;

if (CHAPTER_DURATION_MINUTES < 60) {
  // Case 1: Duration is less than an hour. Use the minute field.
  // Example: For 20 minutes -> '*/20 * * * *'
  HISTORY_CHAPTER_SCHEDULE_CRON = `*/${CHAPTER_DURATION_MINUTES} * * * *`;
} else {
  // Case 2: Duration is one or more hours. Use the hour field.
  const hours = CHAPTER_DURATION_MINUTES / 60;
  if (CHAPTER_DURATION_MINUTES % 60 !== 0) {
    console.warn(`[sntnz config] WARNING: CHAPTER_DURATION_MINUTES (${CHAPTER_DURATION_MINUTES}) is not a clean multiple of 60. The cron schedule may not run as expected.`);
  }

  // Render.com doesn't accept "*/N" in the hours field reliably, so expand manually
  if (Number.isInteger(hours)) {
    const hourList = Array.from({ length: 24 / hours }, (_, i) => i * hours).join(',');
    HISTORY_CHAPTER_SCHEDULE_CRON = `0 ${hourList} * * *`;
  } else {
    HISTORY_CHAPTER_SCHEDULE_CRON = `*/${CHAPTER_DURATION_MINUTES} * * * *`; // fallback
  }
}

module.exports = {
  // --- Round / sentence ---
  ROUND_DURATION_SECONDS: isProduction ? ROUND_DURATION_SECONDS_PROD : ROUND_DURATION_SECONDS_DEV,
  CURRENT_TEXT_LENGTH: 100,

  // --- Client UX ---
  INPUT_MAX_CHARS: 25,
  ANONYMOUS_MAX_SUB_PER_HOUR: 10,
  NUM_INITIAL_CHAPTERS: 3,

  // --- Bot / seeding ---
  ANONYMOUS_NAME: "Anonymous",
  BOT_NAME: "SNTNZ_BOT",
  BOT_ID: "sntnz_bot",
  AI_TIMEOUT_MS: 50000,

  BOT_STOP_WORDS:['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with', 'of', 'by', 'is', 'am', 'are', 'was', 'were', 'his', 'her', 'its', 'like'],

  // --- MODELS ---
  IMAGEN_MODEL:'imagen-3.0-generate-001',
  GEMINI_MODEL_LITE:'gemini-2.5-flash-lite',
  GEMINI_MODEL_FLASH:'gemini-2.5-flash',
  GEMINI_MODEL_PRO:'gemini-2.5-pro',

  // --- Social Media ---
  DEFAULT_SOCIAL_IMAGE_URL: 'https://storage.googleapis.com/sntnz-assets/default-social-image.png',
  TWITTER_MAX_CHARS: 250,
  IG_MAX_CHARS: 400,
  FB_GRAPH_VERSION: 'v23.0',
  FB_USER_TOKEN_REFRESH_SCHEDULE_CRON: '30 3 * * *',
  SOCIAL_HASHTAGS: '#AIart #GenerativeArt #AutonomousArt #CollaborativeWriting #DigitalLiterature #Automation #AIGenerated #AI #TextToImage #ArtMachine #AIBot #EndlessStory #CollectiveCreativity #CreativeCoding #WritingCommunity #Web3 #DigitalOwnership #NFTart #AIartist #sntnz',
  SOCIAL_X_HASHTAGS: '#AIart #GenerativeArt #CollaborativeWriting #CreativeCoding #sntnz',

  // --- Validation ---
  PUNCTUATION_REGEX_STRING: "^[(\"'*_]*[a-zA-Z0-9'-]+[.,!?;:...\"'_)]*$",

  // --- History ---
  CHAPTER_DURATION_MINUTES: CHAPTER_DURATION_MINUTES,
  HISTORY_CHAPTER_SCHEDULE_CRON: HISTORY_CHAPTER_SCHEDULE_CRON,

  // --- Writing Styles ---
  "WRITING_STYLES": [
    {
      "name": "Tolkien-esque High Fantasy",
      "description": "Formal, epic prose on history, landscapes, and myth.",
      "enforce": [
        "elevated formal prose",
        "archaic vocabulary",
        "mythological undertones",
        "sweeping landscapes",
        "deep history focus",
        "quests & ancient evils",
        "features allegorical, oneiric creatures",
        "surreal, evocative, symbolic tone"
      ]
    },
    {
      "name": "Graphic Novel Narration",
      "description": "Clipped, visual style using short sentences and immediate action.",
      "enforce": [
        "present tense narration",
        "short, declarative sentences",
        "strong active verbs",
        "focus on visual action",
        "internal monologue fragments",
        "cinematic, panel-like descriptions",
        "depicts striking, graphic creatures",
        "surreal, dreamlike (oneiric) atmosphere"
      ]
    },
    {
      "name": "Gothic Thriller",
      "description": "Dark, atmospheric style of psychological dread and suspense.",
      "enforce": [
        "moody, atmospheric tone",
        "psychological suspense",
        "themes of decay & madness",
        "complex, tense sentences",
        "uneasy sensory details",
        "foreshadowing & ambiguity",
        "features ethereal, symbolic creatures",
        "powerful, evocative, oneiric narrative"
      ]
    },
    {
      "name": "Pastoral Fantasy",
      "description": "A gentle, wondrous style focused on the serene beauty of nature and the harmonious existence of fantastical creatures.",
      "enforce": [
        "serene and gentle tone",
        "deep reverence for nature",
        "lush, vibrant landscapes",
        "themes of harmony and symbiosis",
        "descriptive, sensory-rich prose",
        "contemplative, peaceful pacing",
        "features beautiful, benign, and wondrous creatures",
        "serene, dreamlike (oneiric) atmosphere"
      ]
    },
    {
      "name": "Hard Science Fiction",
      "description": "Precise, technical style about scientific accuracy and problem-solving.",
      "enforce": [
        "technical, precise language",
        "plausible science concepts",
        "focus on technology & systems",
        "analytical narrative",
        "understated, professional tone",
        "themes of discovery & consequence",
        "describes surreal, allegorical aliens",
        "encounter is dreamlike & resonant"
      ]
    },
    {
      "name": "Age of Exploration Journal",
      "description": "First-person observational style mimicking an explorer's log.",
      "enforce": [
        "first-person logbook format",
        "observational & descriptive",
        "sense of wonder",
        "practical, matter-of-fact tone",
        "catalogs new flora & fauna",
        "journey into the unknown",
        "logs discovery of striking, dreamlike creatures",
        "descriptions are evocative & oneiric"
      ]
    },
    {
      "name": "Epic Historical Chronicle",
      "description": "Grand, formal style of sagas, focusing on battles and fate.",
      "enforce": [
        "sweeping, formal narration",
        "details of armies & tactics",
        "themes of lineage & glory",
        "fatalistic undertones",
        "archaic, martial vocabulary",
        "inevitable conflict",
        "chronicles battles with symbolic, dreamlike beasts",
        "resonant, allegorical, ethereal tone"
      ]
    },
    {
      "name": "Mythopoetic (Mythological)",
      "description": "Timeless, allegorical style of oral traditions with archetypes.",
      "enforce": [
        "archetypal characters",
        "cosmic imagery & symbolism",
        "cyclical view of time",
        "elevated, ritual language",
        "themes of fate & sacrifice",
        "sense of timelessness",
        "focus on potent, oneiric creatures",
        "powerfully dreamlike & metaphorical language"
      ]
    },
    {
      "name": "Whimsical Fairy Tale",
      "description": "Playful, surreal style with nonsensical logic and talking beings.",
      "enforce": [
        "whimsical, playful narration",
        "dreamlike, illogical events",
        "talking animals or objects",
        "wordplay & riddles",
        "themes of curiosity & strangeness",
        "lighthearted yet unsettling tone",
        "populated by gripping, surreal creatures",
        "powerfully oneiric & allegorical tale"
      ]
    },
    {
      "name": "Comic Book Action",
      "description": "Fast, exaggerated, cinematic style with bold, kinetic action.",
      "enforce": [
        "bold exclamations (e.g., 'BAM!')",
        "hyper-dynamic verbs",
        "quick perspective shifts",
        "larger-than-life characters",
        "dramatic one-liners",
        "stylized spectacle",
        "action involves potent, graphic creatures",
        "striking, surreal, dreamlike intensity"
      ]
    },
    {
      "name": "Cinematic Science Fiction",
      "description": "Vivid, cinematic style focused on atmosphere, suspense, and spectacle.",
      "enforce": [
        "atmospheric, visual narration",
        "suspenseful pacing",
        "high-tech meets human vulnerability",
        "focus on survival or awe",
        "precise, not overly technical language",
        "dread to transcendence tone",
        "showcases ethereal, surreal aliens",
        "gripping, dreamlike (oneiric), metaphorical"
      ]
    },
    {
      "name": "Modern Superhero Prose",
      "description": "Cinematic, high-stakes style blending epic action with the hero's personal drama and moral conflicts.",
      "enforce": [
        "blend of epic scale and personal stakes",
        "themes of power, identity, and responsibility",
        "dynamic, cinematic action sequences",
        "internal monologue about duty or doubt",
        "shifts between high-octane pacing and quiet character moments",
        "dialogue balances witty banter with moral debates",
        "features cosmic, oneiric threats or reality-bending villains",
        "surreal, high-concept, and powerfully allegorical"
      ]
    },
    {
      "name": "Vernian Sci-Fi Adventure",
      "description": "An optimistic and formal 19th-century style focused on scientific wonder, meticulous explanations, and grand journeys.",
      "enforce": [
        "optimistic tone with a profound sense of wonder",
        "formal, almost academic prose",
        "detailed descriptions of fictional technology and natural phenomena",
        "themes of exploration, discovery, and human ingenuity",
        "protagonists are often gentlemen explorers or brilliant inventors",
        "a spirit of adventure into the unknown",
        "encounters with bizarre, oneiric deep-sea or subterranean life",
        "the unknown is rendered in a detailed, dreamlike fashion"
      ]
    },
    {
      "name": "Grimdark Political Fantasy",
      "description": "A gritty, cynical style focused on political intrigue, morally complex characters, and the brutal realities of power.",
      "enforce": [
        "gritty, cynical, and realistic tone",
        "focus on political scheming, betrayal, and power struggles",
        "morally ambiguous characters; no clear heroes or villains",
        "sudden, consequential, and unsentimental violence",
        "dialogue is a weapon for manipulation",
        "a grounded world where magic is often rare, dangerous, or subtle",
        "features rare, terrifying, and symbolic creatures",
        "oneiric beasts are treated as grave omens or ancient evils"
      ]
    },
    {
      "name": "Sword & Sorcery",
      "description": "A fast-paced, pulpy style focused on personal heroism, dangerous magic, and thrilling, visceral combat.",
      "enforce": [
        "focus on personal stakes: survival, fortune, or revenge",
        "fast-paced, action-oriented narrative",
        "a capable but often cynical or roguish protagonist",
        "magic is mysterious, dangerous, and often corrupting",
        "a dark and perilous ancient world",
        "visceral, moment-to-moment descriptions of conflict",
        "battles with monstrous, surreal beasts from forgotten ages",
        "the tone is adventurous, dark, and dreamlike"
      ]
    },
    {
      "name": "Cyberpunk Dystopia",
      "description": "A gritty, rebellious style set in a neon-drenched, high-tech future where humanity is cheap and technology is everything.",
      "enforce": [
        "a 'high tech, low life' ethos",
        "themes of transhumanism, corporate control, and identity",
        "dense urban setting with towering skyscrapers and grimy streets",
        "heavy use of technobabble, street slang, and invented jargon",
        "a cynical, anti-authoritarian tone",
        "focus on cybernetics, artificial intelligence, and virtual reality",
        "navigates a surreal, dreamlike digital world (the Net)",
        "AI and digital consciousness are portrayed as oneiric, god-like entities"
      ]
    }
  ],

  // --- Image styles ---
  "IMAGE_STYLES": [
    {
      "name": "Cinematic Symmetry (Kubrick, Anderson)",
      "description": "Cinematic grandeur and meticulous composition. A scene with perfect one-point perspective and striking symmetry, evoking a sense of profound order and visual storytelling."
    },
    {
      "name": "Masterful Ukiyo-e Woodblock Art",
      "description": "Elegant compositions with expressive, flowing outlines and harmonious flat color fields, refined beauty in the style of Japanese prints."
    },
    {
      "name": "Elegant Art Deco Poster",
      "description": "Luxurious and elegant design. Emphasize sleek, streamlined geometry, lavish ornamentation, capturing the glamour of the Jazz Age."
    },
    {
      "name": "Organic Art Nouveau Poster",
      "description": "Characterized by organic, flowing, and sensuous 'whiplash' curves. The design is highly ornamental and decorative."
    },
    {
      "name": "Master Technical Engraving",
      "description": "An intricate masterpiece of technical illustration. Scientific elegance."
    },
    {
      "name": "Ancient Egyptian Fresco",
      "description": "A formal, hieratic scene with crisp, clear black outlines and a palette of rich, flat mineral pigments."
    },
    {
      "name": "Vibrant Mesoamerican Codex",
      "description": "Vibrant and mythological art with bold, confident contour lines, flat fields of intense color."
    },
    {
      "name": "Cinematic Film Noir",
      "description": "A high-contrast, atmospheric black and white composition. Create a world of mystery, tension, and stylized beauty."
    },
    {
      "name": "Harmonious Bauhaus Design",
      "description": "A clean, functional, and harmonious design. Create a sense of rational order and clarity."
    },
    {
      "name": "Neo-Futuristic Anime Aesthetic",
      "description": "Hyper-detailed technical illustration with razor-sharp linework. Create a cinematic and atmospheric feel."
    },
    {
      "name": "Profound Minimalism",
      "description": "A radically simplified composition using clean lines, bold geometric forms, and a masterful use of negative space."
    },
    {
      "name": "Epic Fantasy Painting",
      "description": "An epic, high-fantasy oil painting. Features powerful, dynamic figures, dramatic action, and a rich, painterly texture."
    },
    {
      "name": "Exquisite Mughal Miniature",
      "description": "An exquisitely detailed painting. Utilize exceptionally fine, crisp brushwork and a rich palette of opaque watercolors with delicate patterns."
    },
    {
      "name": "Grand Neoclassicism",
      "description": "A grand masterpiece with the clarity of classical forms. Features sharp, clean contours, dramatic, sculptural lighting."
    },
    {
      "name": "Dreamlike Symbolist Art",
      "description": "A dreamlike, Symbolist vision. Rich, decadent color palette, and mysterious atmosphere."
    },
    {
      "name": "Master Engraver's Print",
      "description": "A masterful engraving in the style of Dürer or Doré. Use powerful, expressive ink lines and intricate crosshatching."
    },
    {
      "name": "Dynamic Futurist Art",
      "description": "A vibrant artwork capturing the sensation of dynamism, speed, and mechanical energy."
    },
    {
      "name": "Soviet Constructivist Poster",
      "description": "Revolutionary graphic design using stark geometric shapes, strong lines, and bold palettes. NO TEXT."
    },
    {
      "name": "Technical Blueprint Schematic",
      "description": "The clean, precise aesthetic of an architectural or engineering drawing. Crisp lines and detailed diagrams revealing inner workings."
    },
    {
      "name": "Mecha Concept Illustration",
      "description": "Hyper-detailed illustration with machineries. A focus on sharp panel lines and angular silhouettes."
    },
    {
      "name": "Chinese Poster Art",
      "description": "Dynamic and idealized graphical style. Features bold figures and strong compositional lines, rendered with a powerful, illustrative quality."
    },
    {
      "name": "Japanese Poster Art",
      "description": "Dynamic and idealized graphical style. Features bold figures and strong compositional lines, rendered with a powerful, illustrative quality."
    },
    {
      "name": "Comic Book Art",
      "description": "Vibrant, highly detailed, dynamic imagery inspired by classic comic books. Features bold outlines, strong action, and a palette of bright, flat colors."
    },
    {
      "name": "Ligne Claire Comic Style",
      "description": "Clean, precise and highly detailed European comic art. Uniform black outlines define all elements, with flat, bright colors and no visible shading or hatching."
    },
    {
      "name": "Dreamlike Aquarelle",
      "description": "Soft, ethereal and highly detailed imagery rendered in watercolor."
    }
  ]
};
