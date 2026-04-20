# Workflow Examples

Nexus is natural language first. Everything below — creating workspaces, scheduling workflows, managing tasks, organizing files — is done by telling the AI what you want. You can also use the settings UI for any of this, but you never have to leave the conversation.

---

## Workspaces: Your AI Project Folders

Workspaces scope your AI sessions to a context. When you load a workspace, the AI knows your project's goals, history, and previous conversations.

### Starting a new project

> "Create a workspace called 'Q2 Product Launch'"

This creates a named container. From now on, loading this workspace gives the AI all the context from your launch planning sessions.

### Loading and switching

> "Load my Q2 Product Launch workspace"

> "What workspaces do I have?"

> "Load the Research workspace instead"

### Saving states

States are save points — immutable captures of your workspace context at a moment in time.

> "Save the current state as 'Pre-launch checklist done'"

> "What states have I saved?"

> "Load the state from before we reorganized the timeline"

### Archiving

> "Archive the Q1 Retrospective workspace — we're done with it"

Archived workspaces can be restored later if needed.

---

## Workflows: Automated Routines

Workflows are reusable procedures that live inside a workspace. They can run on a schedule or on demand.

### Creating a daily review

> "Add a workflow to this workspace called 'Morning Briefing' that runs daily at 8:30am. It should check what notes were modified yesterday, list any overdue tasks, and summarize upcoming deadlines."

### Creating a weekly digest

> "Create a workflow called 'Weekly Research Digest' that runs every Monday at 9am. It should find all notes I created or modified in my Research folder this past week and compile a summary."

### Testing a workflow

> "Run the Morning Briefing workflow now"

This triggers it immediately so you can see the output without waiting for the schedule.

### Workflows with saved prompts

> "Create a prompt called 'Journal Reflection' that asks thoughtful questions about my day"

> "Now create a workflow that runs that prompt every evening at 8pm"

Workflows can bind to any saved prompt, combining your custom instructions with scheduling.

### Catch-up after being offline

If Obsidian was closed during a scheduled run, workflows can catch up:

- **Skip missed** — Just resume from now
- **Run latest missed** — Execute the most recent missed run
- **Run all missed** — Execute every missed run in order

---

## Note Management

### Quick capture

> "Create a note called 'Meeting — March 13' in my Meetings folder with attendees, discussion points, and action items sections"

### Batch operations

> "Move all the notes in my Inbox folder to the Archive folder"

> "Find every note tagged #draft and list them for me"

### Smart editing

> "Open my 'Project Plan' note and replace the timeline section with an updated version that pushes everything back two weeks"

> "Append today's standup notes to my 'Sprint Log' note"

### Content generation

> "Read my 'Research Notes' note and create a new note called 'Research Summary' that synthesizes the key findings"

---

## Search and Discovery

### Keyword search

> "Search for 'authentication' across my entire vault"

> "Find all notes in my Architecture folder that mention 'caching'"

### Semantic search

> "Find notes about improving team productivity" *(finds relevant notes even if they don't use those exact words)*

> "What have I written that's related to this quote: 'simplicity is the ultimate sophistication'?"

### Conversation memory

> "What did we discuss about the database migration last week?"

> "Remind me what decisions we made about the API design"

These search your past conversations with the AI, not just vault notes.

---

## Task Management

### Setting up a project

> "Create a project called 'App Redesign' in this workspace"

> "Add tasks: user research, wireframes, prototype, user testing, final design. Make each one depend on the previous."

### Checking status

> "Show me all tasks in the App Redesign project"

> "What tasks can I start right now?" *(shows unblocked tasks)*

> "What's overdue?"

### Updating progress

> "Mark the user research task as complete"

> "Change the prototype task's due date to next Friday"

> "Assign the wireframes task to Sarah"

### Linking to notes

> "Link my 'User Interview Notes' note to the user research task"

Now the task and the note reference each other.

### Cross-project queries

> "Show me all high-priority tasks across all my projects"

> "What tasks are assigned to me that are due this week?"

---

## Apps

### ElevenLabs (audio generation)

> "Convert my 'Blog Post' note to speech and save it to Audio/"

> "List available voices"

> "Generate a 'gentle rain on a window' sound effect"

> "Generate a calm lo-fi study track, 30 seconds"

Audio files are saved directly into your vault.

---

## Combining Features

The real power is in combining these together:

> "Load my Thesis workspace. Find all notes I modified this week about methodology. Summarize the key changes and create a task to review the methodology section by Friday."

> "Search my vault for anything about competitor analysis, compile it into a new note, and add a task to update it monthly."

>> "What states have I saved for this workspace? Load the one from before the big reorganization so I can compare what changed."
