"""Offline test boundary: no external network, torch, or model imports."""
import importlib.abc
import ipaddress
import socket
import sys

import pytest


class _NoModels(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split('.')[0] in {'torch', 'torchaudio', 'demucs'}:
            _attempts.append(f'import {fullname}')
            raise AssertionError(f'Test attempted a forbidden model import: {fullname}')
        return None


_attempts = []
_patch = None
_finder = _NoModels()


def _local(host):
    if host in {'localhost', None, ''}:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def pytest_sessionstart(session):
    """Allow OS loopback socketpairs, but reject DNS/TCP to the internet."""
    global _patch
    assert not {'torch', 'torchaudio', 'demucs'} & sys.modules.keys()
    sys.meta_path.insert(0, _finder)
    _patch = pytest.MonkeyPatch()
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_resolve = socket.getaddrinfo

    def guarded(method):
        def call(sock, address, *args, **kwargs):
            if isinstance(address, tuple) and not _local(address[0]):
                _attempts.append(f'network {address[0]}')
                raise AssertionError(f'External network disabled in tests: {address[0]}')
            return method(sock, address, *args, **kwargs)
        return call

    def resolve(host, *args, **kwargs):
        if not _local(host):
            _attempts.append(f'DNS {host}')
            raise AssertionError(f'External DNS disabled in tests: {host}')
        return original_resolve(host, *args, **kwargs)

    _patch.setattr(socket.socket, 'connect', guarded(original_connect))
    _patch.setattr(socket.socket, 'connect_ex', guarded(original_connect_ex))
    _patch.setattr(socket, 'getaddrinfo', resolve)


def pytest_sessionfinish(session, exitstatus):
    if _patch is not None:
        _patch.undo()
    if _finder in sys.meta_path:
        sys.meta_path.remove(_finder)
    if _attempts:
        session.exitstatus = pytest.ExitCode.TESTS_FAILED
        reporter = session.config.pluginmanager.get_plugin('terminalreporter')
        if reporter:
            reporter.write_line(f'Forbidden network/model attempts: {_attempts}', red=True)
