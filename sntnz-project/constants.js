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

const ROUND_DURATION_SECONDS_DEV = 10;
const CHAPTER_DURATION_MINUTES_DEV = 5;

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
      "name": "Lyrical Romance",
      "description": "Emotive style on feelings and sensory details with figurative language.",
      "enforce": [
        "focus on emotion",
        "rich sensory details",
        "use of metaphor & simile",
        "poetic sentence structure",
        "themes of connection & beauty",
        "intimate perspective",
        "incorporates ethereal, symbolic creatures",
        "resonant, dreamlike (oneiric) quality"
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
      "name": "Pulp Gothic Horror",
      "description": "Visceral horror with monsters, dread, and melodramatic flair.",
      "enforce": [
        "lurid, sensational descriptions",
        "suspenseful pacing",
        "grotesque imagery",
        "strong emotional reactions",
        "classic horror settings",
        "themes of death & fear",
        "features grotesque, dreamlike creatures",
        "potent, surreal, oneiric dread"
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
    }
  ],

  // --- Image styles ---
  "IMAGE_STYLES": [
    {
      "name": "Mesoamerican Codex",
      "description": "Bold, geometric manuscript style with flat colors, symbolic glyphs, and ornamental banding on bark paper."
    },
    {
      "name": "Egyptian Papyrus Fresco",
      "description": "Linear, narrative style on papyrus with composite perspective, black outlines, and mineral pigment colors."
    },
    {
      "name": "Mughal Miniature Painting",
      "description": "Highly detailed, courtly manuscript art with fine brushwork, jeweled tones, and ornate gold borders."
    },
    {
      "name": "Japanese Ukiyo-e & Rimpa School",
      "description": "Graphic woodblock prints and paintings with bold outlines, flat colors, and decorative gold leaf patterns."
    },
    {
      "name": "Dutch Golden Age Chiaroscuro",
      "description": "Dramatic oil-on-canvas style using deep light-dark contrast, warm earth tones, and visible brushwork."
    },
    {
      "name": "Dynamic Art Nouveau",
      "description": "Ornamental lithograph style with flowing whiplash curves, stylized nature motifs, and soft pastel palettes."
    },
    {
      "name": "Streamlined Art Deco",
      "description": "Sleek, geometric style featuring sharp symmetry, sunburst motifs, and a polished metallic or lacquer finish."
    },
    {
      "name": "Generative Glitch Art",
      "description": "Digital art style using algorithmic distortion, datamoshing, RGB splits, and other pixelated artifacts."
    },
    {
      "name": "Anachronic Steampunk Mechanics",
      "description": "Victorian-inspired technical art with engraved blueprint lines, crosshatching, and brass and leather textures."
    },
    {
      "name": "Mid-Century Graphic Optimism",
      "description": "Modernist silkscreen style with playful geometry, clean grids, simple icons, and a cheerful primary palette."
    },
    {
      "name": "Psychedelic 70s Funk",
      "description": "Vibrant concert-poster art with swirling forms, trippy motifs, and vibrating complementary acid-bright colors."
    },
    {
      "name": "80s Neon & Memphis Design",
      "description": "Bold, postmodern style with flat neon colors, playful geometric patterns, and retro drop shadows."
    },
    {
      "name": "90s Grunge & Analog Glitch",
      "description": "Distressed, layered aesthetic with photocopy noise, tape scuffs, bitmap halftones, and hand-cut collage edges."
    },
    {
      "name": "80s Cyberpunk Anime Opus",
      "description": "Cinematic retro-futuristic anime style with high-density technical lineart, cel shading, and neon accents."
    },
    {
      "name": "Kubrickian One-Point Perspective",
      "description": "Cinematic style defined by perfect one-point perspective, austere symmetry, and precise geometric framing."
    },
    {
      "name": "Lynchian Industrial Surrealism",
      "description": "Eerie, atmospheric style with industrial textures, moody monochrome palettes, and uncanny, dreamlike staging."
    },
    {
      "name": "Abstract Expressionist Gestures",
      "description": "Energetic, large-scale style with expressive paint drips, splatters, and assertive, layered impasto brush marks."
    },
    {
      "name": "Bauhaus Functionalist Design",
      "description": "Orderly design with geometric clarity, strict modular grids, and a primary color palette on poster board."
    },
    {
      "name": "Expressive Black & White Minimalism",
      "description": "High-contrast monochrome style using bold shapes, sharp lines, and disciplined use of negative space."
    },
    {
      "name": "Japanese Mono-ha & Wabi-Sabi",
      "description": "Contemplative style emphasizing natural materials, restrained ink wash, and asymmetrical balance with empty space."
    },
    {
      "name": "Italian High Renaissance Sfumato",
      "description": "Harmonious oil painting style with soft tonal blending (sfumato), layered glazing, and subtle chiaroscuro."
    },
    {
      "name": "Flemish Baroque Dynamism",
      "description": "Theatrical oil-on-canvas style with dynamic diagonal compositions, rich glazing, and lively, dramatic brushwork."
    },
    {
      "name": "Romantic Sublime Landscape",
      "description": "Atmospheric oil paintings of grand landscapes with dramatic skies, epic scale, and luminous backlighting."
    },
    {
      "name": "Impressionist En Plein Air",
      "description": "Spontaneous style focused on capturing flickering light with visible brushstrokes and vibrating complementary colors."
    },
    {
      "name": "Pointillist Color Theory",
      "description": "Systematic painting style using precise dots of pure pigment for optical color mixing on canvas."
    }
  ]
};
