/**
 * Curated memorial poem library.
 *
 * Every poem here is ORIGINAL and ours. That is not a stylistic preference, it
 * is a legal requirement: a customer can select one of these and we print it on
 * a product we sell. The library previously carried the Rainbow Bridge piece
 * (credited in 2023 to Edna Clyne-Rekhy, so a work by a known living author),
 * "When Tomorrow Starts Without Me" by David Romano, and several unattributed
 * contemporary verses marked "Unknown". Reproducing verse in an article has a
 * fair-use argument. Printing it on a product for sale has none, and "Unknown"
 * does not cure it: an orphan work still belongs to whoever wrote it.
 *
 * Only Van Dyke survives from the old set. He died in 1933, so that one is
 * genuinely public domain.
 *
 * Craft rules these were written to, and any future addition must meet:
 *   - No line longer than ~34 characters. The tribute panel is narrow, and a
 *     long line gets re-broken by the setter at whatever point it runs out of
 *     room, which is how a phrase ends up split in the wrong place.
 *   - No em dashes anywhere.
 *   - Banned register: rainbow bridge, wings, watching over, in a better place,
 *     forever in my heart, paw prints on my heart, until we meet again, spirit
 *     lives on, rest easy, gone too soon, heaven gained an angel.
 *   - Concrete over abstract. A library poem cannot name one specific animal,
 *     but it can name a real object and a real hour. "The bowl is still in the
 *     corner" belongs to everyone who has one and to nobody else's poem.
 *   - No forced rhyme and no perfect metre. Sing-song reads generated.
 */

const poems = [
  {
    id: 'the-bowl',
    title: 'The Bowl',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'The bowl is still in the corner. I have not moved it...',
    text: `The bowl is still in the corner.
I have not moved it.

Twice a day my hands still know
the weight of the bag,
the sound it made going in,
the way you came
from wherever you were.

Hands remember longer
than the rest of us do.

I will move it
when I move it.`
  },
  {
    id: 'the-hour',
    title: 'The Hour That Was Yours',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'There was an hour that belonged to you. Late afternoon...',
    text: `There was an hour
that belonged to you.

Late afternoon, when the light
went long and low,
you would find me
wherever I was
and put your whole weight down.

The hour still comes.
It arrives at the same time,
finds the room
the way we left it.

I keep it anyway.`
  },
  {
    id: 'stepping-over',
    title: 'Stepping Over',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'For years I stepped over you in the dark, in the doorway...',
    text: `For years I stepped over you
in the dark, in the doorway,
in the exact wrong place,
every time, without thinking.

Last night I stepped over nothing.

My body still knows
where you were.

Let it.
It is the last thing that does.`
  },
  {
    id: 'the-ordinary-years',
    title: 'The Ordinary Years',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'You did not know you were a comfort. You thought you were simply here...',
    text: `You did not know
you were a comfort.

You thought you were simply here,
lying where the sun was,
waiting for someone
to come home.

That was the whole job,
and you did it better
than anyone has ever done
anything.

Thank you for the ordinary years.
They were the good ones.`
  },
  {
    id: 'the-warm-places',
    title: 'The Warm Places',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'You chose me the way cats choose, which is to say you arrived...',
    text: `You chose me the way cats choose,
which is to say you arrived
and made it look
like my idea.

You slept where the warm was.
You came when it suited you,
and it suited you
more than you let on.

The warm places are still here.
Nobody is using them.`
  },
  {
    id: 'the-best-word',
    title: 'The Best Word in the House',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'I say your name out loud sometimes in an empty kitchen...',
    text: `I say your name out loud
sometimes, in an empty kitchen,
for no reason,

the way you say a word
to check that it still works.

It works.

It is still the best word
in the house.`
  },
  {
    id: 'both-are-true',
    title: 'Both Are True',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'Fifteen years is a long time to be met at the door...',
    text: `Fifteen years is a long time
to be met at the door,
to be followed room to room,
to be sat beside
without being asked.

It is also no time at all.

Both of those are true
and I have stopped trying
to make them agree.`
  },
  {
    id: 'the-short-version',
    title: 'The Short Version',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'We did not get the years we planned for. We got the ones we got...',
    text: `We did not get
the years we planned for.

We got the ones we got,
and you spent every one of them
entirely certain
that you were home.

I would not trade
the short version.

I would just have liked
more of it.`
  },
  {
    id: 'the-house-learned',
    title: 'What the House Learned',
    author: 'Still Beside Me',
    category: 'pet',
    preview: 'Nobody meets me at the door now. I still say the words out loud...',
    text: `Nobody meets me at the door now.
I still say the words out loud.

The house has learned
a different quiet,
the kind that does not
lift its head.

You were the sound
this place made.

I am learning the new one
slowly, and I am not
in a hurry.`
  },
  {
    id: 'gone-from-sight',
    title: 'Gone From My Sight',
    author: 'Henry Van Dyke',
    category: 'universal',
    preview: 'I am standing upon the seashore...',
    text: `I am standing upon the seashore.
A ship at my side spreads her white sails
to the morning breeze
and starts for the blue ocean.

She is an object of beauty and strength.
I stand and watch her until at length
she hangs like a speck of white cloud
just where the sea and sky
come to mingle with each other.

And someone at my side says,
"There, she is gone."

Gone where?
Gone from my sight, that is all.
She is just as large in mast and hull
and spar as she was when she left my side.

And just at the moment
when someone at my side says,
"There, she is gone,"
there are other eyes watching her coming,
and other voices ready to take up the glad shout,

"Here she comes!"`
  }
];

module.exports = poems;
