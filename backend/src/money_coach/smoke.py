"""Send one tiny greeting directly to Claude, without database access or tools."""
import argparse
import getpass
import os
import sys

import anthropic

from .client import DEFAULT_MODEL, create_client


def read_clipboard() -> str:
    """Read locally only when --clipboard is explicitly selected; never print the value."""
    try:
        import tkinter
    except ImportError:
        raise RuntimeError("Clipboard support requires Python's tkinter component.") from None
    root = None
    try:
        root = tkinter.Tk()
        root.withdraw()
        return root.clipboard_get()
    except tkinter.TclError:
        raise RuntimeError("Cannot read clipboard text. Copy the full API key and try again.") from None
    finally:
        if root is not None:
            root.destroy()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clipboard", action="store_true",
                        help="Wait for you to copy the full key, then read it locally without displaying or saving it")
    args = parser.parse_args(argv)
    if args.clipboard:
        if not sys.stdin.isatty():
            print("Run --clipboard in an interactive terminal.", file=sys.stderr)
            return 1
        input("Copy the FULL Anthropic API key now, then return here and press Enter (do not paste it): ")
        try:
            key = read_clipboard().strip()
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return 1
    else:
        key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if not key and not args.clipboard:
        if not sys.stdin.isatty():
            print("Set ANTHROPIC_API_KEY, or run in a terminal for a hidden key prompt.", file=sys.stderr)
            return 1
        key = getpass.getpass("Anthropic API key (hidden, not saved): ").strip()
    if (not key.startswith("sk-ant-") or "..." in key or not key.isascii()
            or any(ord(c) <= 32 or ord(c) == 127 for c in key)):
        print("That is not a full API key. Copy the complete sk-ant- key shown at creation, without dots or hidden paste-control characters. No request sent.", file=sys.stderr)
        return 1
    client = create_client(api_key=key, max_retries=0)
    if client is None:
        print("An Anthropic API key is required.", file=sys.stderr)
        return 1
    try:
        with client:
            # Sonnet 5.5 uses between_tools to skip up-front thinking.
            response = client.messages.create(
                model=DEFAULT_MODEL, max_tokens=32, thinking={"type": "between_tools"},
                messages=[{"role": "user", "content": "hi"}],
            )
        answer = "\n".join(b.text for b in response.content if b.type == "text")
        if not answer.strip():
            print("Claude returned no text; inspect model access and output limits.", file=sys.stderr)
            return 1
        print(answer)
        print(f"Tokens: {response.usage.input_tokens} input, {response.usage.output_tokens} output")
        return 0
    except anthropic.AuthenticationError:
        print("Anthropic rejected the API key. Check the key's workspace and validity.", file=sys.stderr)
    except anthropic.RateLimitError:
        print("Anthropic rate limit reached. Check the Anthropic Console limits and retry later.", file=sys.stderr)
    except anthropic.APIError as exc:
        # Don't dump HTTP requests, credentials or provider response bodies.
        print(f"Anthropic request failed ({type(exc).__name__}). Check connectivity, model access and credit in the Anthropic Console.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
