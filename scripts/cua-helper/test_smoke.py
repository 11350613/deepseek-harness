"""Smoke command failures retain native diagnostics without performing desktop operations."""
from contextlib import redirect_stderr
import io
import subprocess
import unittest
from unittest.mock import patch

import smoke


class SmokeDiagnostics(unittest.TestCase):
    def test_success_returns_captured_reply_without_replaying_it(self):
        result = subprocess.CompletedProcess(["helper"], 0, '{"type":"ready"}', "")
        diagnostics = io.StringIO()
        with patch.object(smoke.subprocess, "run", return_value=result) as run, redirect_stderr(diagnostics):
            self.assertIs(smoke.run_checked(["helper"], 25), result)
        run.assert_called_once_with(["helper"], check=True, capture_output=True, text=True, timeout=25)
        self.assertEqual(diagnostics.getvalue(), "")

    def test_native_failure_keeps_code_message_and_stderr(self):
        error = subprocess.CalledProcessError(1, ["helper"],
                                            output='{"type":"error","code":"NATIVE_STARTUP","message":"launch failed"}',
                                            stderr="native diagnostic")
        diagnostics = io.StringIO()
        with patch.object(smoke.subprocess, "run", side_effect=error), redirect_stderr(diagnostics):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                smoke.run_checked(["helper"], 25)
        self.assertIs(raised.exception, error)
        self.assertIn(error.stdout, diagnostics.getvalue())
        self.assertIn(error.stderr, diagnostics.getvalue())

    def test_timeout_keeps_partial_bytes_and_exit_failure(self):
        error = subprocess.TimeoutExpired(["helper"], 25, output=b"partial reply", stderr=b"startup timeout")
        diagnostics = io.StringIO()
        with patch.object(smoke.subprocess, "run", side_effect=error), redirect_stderr(diagnostics):
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                smoke.run_checked(["helper"], 25)
        self.assertIs(raised.exception, error)
        self.assertIn("partial reply", diagnostics.getvalue())
        self.assertIn("startup timeout", diagnostics.getvalue())


if __name__ == "__main__":
    unittest.main()
