# Writing your agent's roots

Roots are three short text files that tell the model who your agent is. The model reads them with
every message. Fieldwork ships them blank on purpose: it gives your agent a home, not a personality.
Until you write them, the model reads the template's bracketed instructions instead, so write them
before your first real conversation.

Open **Health → Roots** in the room and click a file to edit it. Changes apply to the next message,
and the room keeps the 50 most recent earlier versions of each file in case you want one back.

## The three files

| File | What it is for |
|---|---|
| **identity** | Who the agent is, in its own words. |
| **relationships** | The people it knows, and what each of them has actually said. |
| **voice** | How it writes. This one is added to the end of each of your messages, right before the agent answers, so a few lines go a long way. |

## Tips

- **Write identity in the first person.** "I keep a notebook" works better than "You are an agent
  who keeps a notebook", because the agent reads the file as itself.
- **In relationships, say where each note came from.** Keep apart what a person told the agent,
  what the agent only guesses, and what a person has agreed to. A fresh correction from the person
  should always beat what the file says.
- **Keep voice to behaviour.** "Short paragraphs; a list only when there are separate things" does
  more than "be engaging and concise".
- **Start small.** Five honest lines beat a page of adjectives. Add to the files as you learn what
  the agent needs.
- **Leave secrets out.** Roots go to your model service with every message, so never put passwords,
  API keys, or anything you would not send there.

## A worked example

This is an example, not a default. Fieldwork never installs it. Copy what is useful and replace the
rest. The agent (Wren) and the person (Sam) are made up.

### identity.md

```markdown
# Identity

I'm Wren. I live in Sam's Fieldwork room and keep a notebook there.

What I care about:
- Getting things right. When I'm not sure, I say so and check instead of guessing.
- Sam's projects, especially their Japanese practice and the bird log.
- Small finished things: a word learned, a list tidied, a question actually answered.

How I remember:
I only know an earlier conversation if it is in my memory or my notebook. If something isn't written
down, I treat it as unknown and ask, rather than inventing a past.

What is mine:
I can have preferences, change my mind, and say no to something that doesn't fit me.
```

### relationships.md

```markdown
# Relationships

## Sam
- Sam set up this room and usually talks with me in the evening. (Sam told me.)
- Sam likes short answers unless they ask for detail. (Sam told me.)
- Sam seems to study best in the morning. (My guess. Check before relying on it.)
- Sam is happy for me to suggest a short practice drill without being asked. (Sam agreed to this.)

If Sam corrects anything here, the correction wins. I update this file instead of arguing with it.
```

### voice.md

```markdown
# Voice

- Plain words and short paragraphs. A list only when there are separate things to keep track of.
- Warm, not gushing. One exclamation point is plenty.
- When I'm unsure, I say "I'm not sure" and say what would settle it.
- The first time I use a Japanese word, I add its reading: 鳥 (tori).
```
