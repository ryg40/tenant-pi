#!/bin/sh
# tenant-pi ordinary Claude launcher

# Skip every kit copy, including symlinks, without adding a child environment marker.
tenant_claude_path=${PATH-}
tenant_claude_executable=
while :; do
    tenant_claude_directory=${tenant_claude_path%%:*}
    tenant_claude_candidate=${tenant_claude_directory:-.}/claude
    if [ -f "$tenant_claude_candidate" ] && [ -x "$tenant_claude_candidate" ]; then
        tenant_claude_kit=false
        {
            IFS= read -r tenant_claude_line
            if [ "$tenant_claude_line" = '#!/bin/sh' ]; then
                IFS= read -r tenant_claude_line
                [ "$tenant_claude_line" != '# tenant-pi ordinary Claude launcher' ] || tenant_claude_kit=true
            fi
        } < "$tenant_claude_candidate"
        if [ "$tenant_claude_kit" = false ]; then
            tenant_claude_executable=$tenant_claude_candidate
            break
        fi
    fi
    case $tenant_claude_path in
        *:*) tenant_claude_path=${tenant_claude_path#*:} ;;
        *) break ;;
    esac
done
if [ -z "$tenant_claude_executable" ]; then
    printf '%s\n' 'No native claude executable after the kit launcher on PATH.' >&2
    exit 127
fi
if [ -f .credsync.json ]; then
    tenant_claude_source=$0
    while [ -L "$tenant_claude_source" ]; do
        tenant_claude_link=$(readlink "$tenant_claude_source") || break
        case $tenant_claude_link in
            /*) tenant_claude_source=$tenant_claude_link ;;
            *) tenant_claude_source=$(dirname "$tenant_claude_source")/$tenant_claude_link ;;
        esac
    done
    tenant_claude_helper=$(dirname "$tenant_claude_source")/../../skills/herdr/scripts/credsync-launch.sh
    if [ -r "$tenant_claude_helper" ]; then
        exec /bin/sh "$tenant_claude_helper" "$tenant_claude_executable" "$@"
    fi
fi
exec "$tenant_claude_executable" "$@"
