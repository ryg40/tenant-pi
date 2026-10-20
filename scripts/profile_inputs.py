"""The kit files that can change the bytes of a generated profile, as Git pathspecs.

The publisher (`scripts/publish_portable.py`) and the `update` action of `scripts/tenant_pi.py` both use the
list. The module imports nothing, so that both can load it.
"""

# A change in one of these files can change the bytes of a generated profile: the manifest, the two
# generator modules with each kit module that they import, and the launcher writer. The sample overlay
# is not one: a user's overlay is a copy that a later change of the sample does not reach.
PROFILE_INPUTS = ("config/manifest.json", "scripts/profile_plan.py", "scripts/profile_write.py",
                  "scripts/validate.py", "scripts/check_runtime.py", "scripts/memory_modules.py",
                  "scripts/workflow_modules.py", "scripts/model_routes.py", "scripts/models_input.py",
                  "scripts/launcher.py")
