export interface ThinkingWord {
  word: string;
  icon: string;
}

export const THINKING_WORDS: ThinkingWord[] = [
  // Cognitive / classic
  { word: 'Pondering', icon: 'lightbulb' },
  { word: 'Contemplating', icon: 'infinity' },
  { word: 'Reflecting', icon: 'eye' },
  { word: 'Musing', icon: 'sparkles' },
  // Gastronomic
  { word: 'Simmering', icon: 'flame' },
  { word: 'Marinating', icon: 'droplet' },
  { word: 'Percolating', icon: 'coffee' },
  { word: 'Brewing', icon: 'beer' },
  { word: 'Stewing', icon: 'cooking-pot' },
  { word: 'Steeping', icon: 'cup-soda' },
  { word: 'Kneading', icon: 'cookie' },
  { word: 'Fermenting', icon: 'flask-conical' },
  { word: 'Whisking', icon: 'loader-pinwheel' },
  // Craft / artisan
  { word: 'Weaving', icon: 'git-branch' },
  { word: 'Sculpting', icon: 'shapes' },
  { word: 'Whittling', icon: 'slice' },
  { word: 'Drafting', icon: 'pencil-ruler' },
  { word: 'Polishing', icon: 'star' },
  { word: 'Forging', icon: 'anvil' },
  { word: 'Threading', icon: 'git-merge' },
  { word: 'Stitching', icon: 'spool' },
  { word: 'Sharpening', icon: 'sword' },
  // Nature / organic
  { word: 'Blooming', icon: 'flower' },
  { word: 'Germinating', icon: 'sprout' },
  { word: 'Crystallizing', icon: 'diamond' },
  { word: 'Sprouting', icon: 'leaf' },
  { word: 'Blossoming', icon: 'flower-2' },
  // Nerdy / sci-fi
  { word: 'Tessellating', icon: 'hexagon' },
  { word: 'Calibrating', icon: 'sliders-horizontal' },
  { word: 'Synthesizing', icon: 'atom' },
  { word: 'Refracting', icon: 'rainbow' },
  // Whimsical
  { word: 'Noodling', icon: 'line-squiggle' },
  { word: 'Doodling', icon: 'pen-tool' },
  { word: 'Fiddling', icon: 'wrench' },
  // Wizardy / mystical
  { word: 'Conjuring', icon: 'wand-2' },
  { word: 'Channeling', icon: 'zap' },
  { word: 'Scrying', icon: 'orbit' },
  // Tech / retro
  { word: 'Untangling', icon: 'cable' },
  // Action / visceral
  { word: 'Churning', icon: 'washing-machine' },
  { word: 'Grinding', icon: 'gpu' },
  { word: 'Hammering', icon: 'hammer' },
  { word: 'Crunching', icon: 'keyboard' },
  // Vault-specific
  { word: 'Gleaning', icon: 'scan-search' },
  { word: 'Foraging', icon: 'apple' },
  { word: 'Harvesting', icon: 'wheat' },
  { word: 'Curating', icon: 'bookmark' }
];

export const ICON_SUBSTITUTIONS: Record<string, string> = {
  'line-squiggle': 'brain',
  'loader-pinwheel': 'loader-2',
  gpu: 'cpu',
  'washing-machine': 'refresh-cw'
};
