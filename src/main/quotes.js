// Reflection quotes shown after content is closed. Weighted 70% Scripture /
// 30% historical figures. Scripture is King James Version (public domain).
// Themes: temptation, the struggle of addiction, purpose, sin, forgiveness,
// God's love, and standing firm.

const scripture = [
  { text: 'There hath no temptation taken you but such as is common to man: but God is faithful, who will not suffer you to be tempted above that ye are able; but will with the temptation also make a way to escape.', ref: '1 Corinthians 10:13' },
  { text: 'I can do all things through Christ which strengtheneth me.', ref: 'Philippians 4:13' },
  { text: 'Submit yourselves therefore to God. Resist the devil, and he will flee from you.', ref: 'James 4:7' },
  { text: 'Know ye not that your body is the temple of the Holy Ghost which is in you... ye are not your own? Therefore glorify God in your body.', ref: '1 Corinthians 6:19-20' },
  { text: 'Create in me a clean heart, O God; and renew a right spirit within me.', ref: 'Psalm 51:10' },
  { text: 'Be not conformed to this world: but be ye transformed by the renewing of your mind.', ref: 'Romans 12:2' },
  { text: 'Walk in the Spirit, and ye shall not fulfil the lust of the flesh.', ref: 'Galatians 5:16' },
  { text: 'If any man be in Christ, he is a new creature: old things are passed away; behold, all things are become new.', ref: '2 Corinthians 5:17' },
  { text: 'The LORD is nigh unto them that are of a broken heart; and saveth such as be of a contrite spirit.', ref: 'Psalm 34:18' },
  { text: 'Fear thou not; for I am with thee: be not dismayed; for I am thy God: I will strengthen thee; yea, I will help thee.', ref: 'Isaiah 41:10' },
  { text: 'If the Son therefore shall make you free, ye shall be free indeed.', ref: 'John 8:36' },
  { text: 'Blessed are the pure in heart: for they shall see God.', ref: 'Matthew 5:8' },
  { text: 'Sin shall not have dominion over you: for ye are not under the law, but under grace.', ref: 'Romans 6:14' },
  { text: 'Wherewithal shall a young man cleanse his way? by taking heed thereto according to thy word.', ref: 'Psalm 119:9' },
  { text: 'If we confess our sins, he is faithful and just to forgive us our sins, and to cleanse us from all unrighteousness.', ref: '1 John 1:9' },
  { text: 'Trust in the LORD with all thine heart; and lean not unto thine own understanding.', ref: 'Proverbs 3:5' },
  { text: 'Let us not be weary in well doing: for in due season we shall reap, if we faint not.', ref: 'Galatians 6:9' },
  { text: 'God hath not given us the spirit of fear; but of power, and of love, and of a sound mind.', ref: '2 Timothy 1:7' },
  { text: 'Watch and pray, that ye enter not into temptation: the spirit indeed is willing, but the flesh is weak.', ref: 'Matthew 26:41' },
  { text: 'There is therefore now no condemnation to them which are in Christ Jesus.', ref: 'Romans 8:1' },
  { text: 'God is our refuge and strength, a very present help in trouble.', ref: 'Psalm 46:1' },
  { text: 'Put on the whole armour of God, that ye may be able to stand against the wiles of the devil.', ref: 'Ephesians 6:11' },
  { text: 'It is of the LORD’s mercies that we are not consumed... they are new every morning: great is thy faithfulness.', ref: 'Lamentations 3:22-23' },
  { text: 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.', ref: 'John 3:16' },
  { text: 'They that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles.', ref: 'Isaiah 40:31' },
  { text: 'Let us therefore come boldly unto the throne of grace, that we may obtain mercy, and find grace to help in time of need.', ref: 'Hebrews 4:16' },
];

const figures = [
  { text: 'The chains of habit are too weak to be felt until they are too strong to be broken.', author: 'Samuel Johnson' },
  { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche' },
  { text: 'Our greatest glory is not in never falling, but in rising every time we fall.', author: 'Confucius' },
  { text: 'We are what we repeatedly do. Excellence, then, is not an act, but a habit.', author: 'Will Durant' },
  { text: 'It always seems impossible until it is done.', author: 'Nelson Mandela' },
  { text: 'Character cannot be developed in ease and quiet. Only through trial and suffering can the soul be strengthened.', author: 'Helen Keller' },
  { text: 'You have power over your mind — not outside events. Realize this, and you will find strength.', author: 'Marcus Aurelius' },
  { text: 'First we make our habits, then our habits make us.', author: 'John Dryden' },
  { text: 'Strength does not come from physical capacity. It comes from an indomitable will.', author: 'Mahatma Gandhi' },
  { text: 'What lies behind us and what lies before us are tiny matters compared to what lies within us.', author: 'Ralph Waldo Emerson' },
  { text: 'Waste no more time arguing about what a good man should be. Be one.', author: 'Marcus Aurelius' },
  { text: 'Courage is not the absence of fear, but the triumph over it.', author: 'Nelson Mandela' },
  { text: 'The best way out is always through.', author: 'Robert Frost' },
  { text: 'Discipline is the bridge between goals and accomplishment.', author: 'Jim Rohn' },
];

// 70% scripture, 30% historical figures
function pick() {
  const useScripture = Math.random() < 0.7;
  if (useScripture) {
    const q = scripture[Math.floor(Math.random() * scripture.length)];
    return { kind: 'scripture', text: q.text, source: q.ref };
  }
  const q = figures[Math.floor(Math.random() * figures.length)];
  return { kind: 'quote', text: q.text, source: q.author };
}

module.exports = { pick, scripture, figures };
