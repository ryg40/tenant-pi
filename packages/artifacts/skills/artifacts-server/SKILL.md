---
name: artifacts-server
description: "/artifacts-server start | off | status: start, stop or show the local artifacts server and give the URL of its index page."
disable-model-invocation: true
---

# /artifacts-server

1. Run `artifacts <word>` with the word of the user: `start`, `off`, `stop` or `status`. With no word, run `artifacts status`. For another word, name these four words to the user and run nothing.
2. Show the output lines to the user. After `start`, give the URL of the last line in your reply.

A refusal names its reason, for example a port that another program uses and the command `artifacts setup --port N`. Give that reason to the user and run no fix of your own.
