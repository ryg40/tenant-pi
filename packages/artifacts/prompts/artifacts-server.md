---
description: Start, stop or show the local artifacts server, and show the URL of its index page
argument-hint: "[start | off | status]"
---
The word of the user is `${1:-status}`.

1. When the word is `start`, `off`, `stop` or `status`, run `artifacts ${1:-status}`. For another word, name these four words to the user and run nothing.
2. Show the output lines to the user. After `start`, give the URL of the last line in your reply.

A refusal names its reason, for example a port that another program uses and the command `artifacts setup --port N`. Give that reason to the user and run no fix of your own.
