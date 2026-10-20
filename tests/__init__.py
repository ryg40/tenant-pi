"""Repository tests, importable as independent unittest modules."""
import os
import tempfile

# macOS links /tmp and /var into /private. The kit refuses a linked parent, so the fixtures use the resolved form.
tempfile.tempdir = os.path.realpath(tempfile.gettempdir())
