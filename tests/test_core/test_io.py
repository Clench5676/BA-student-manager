"""
Bundle文件I/O测试

测试以下功能:
- load_bundle: 加载bundle文件
- compress_bundle: 压缩方式 (lzma, lz4, none)
- CRC修正与extra_bytes
"""

import pytest
from pathlib import Path

from ba_modding_toolkit.core import (
    load_bundle,
    compress_bundle,
    save_bundle,
    SaveOptions,
)
from ba_modding_toolkit.utils import CRCUtils
from conftest import has_sample_bundle


@pytest.mark.skipif(
    not has_sample_bundle(),
    reason="sample.bundle IS REQUIRED"
)
class TestLoadBundle:
    def test_load_bundle_basic(self, sample_bundle_path: Path):
        env = load_bundle(sample_bundle_path)
        assert env is not None

    def test_load_bundle_read_assets(self, sample_bundle_path: Path):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        assets = list(env.objects)
        assert len(assets) > 0

    def test_load_nonexistent_file(self, tmp_path: Path):
        nonexistent = tmp_path / "nonexistent.bundle"
        env = load_bundle(nonexistent)
        assert env is not None
        assert len(list(env.files)) == 0


@pytest.mark.skipif(
    not has_sample_bundle(),
    reason="sample.bundle IS REQUIRED"
)
class TestCrcFix:
    def test_save_with_crc_fix(
        self, sample_bundle_path: Path, tmp_path: Path
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        target_crc = 12345678
        output_name = f"test_2024-01-01_{target_crc}.bundle"
        output_path = tmp_path / output_name
        
        save_options = SaveOptions(
            perform_crc=True,
            compression="none",
        )
        
        success, msg = save_bundle(env, output_path, save_options)
        assert success is True, msg
        
        actual_crc = CRCUtils.compute_crc32(output_path)
        assert actual_crc == target_crc

    def test_save_without_crc_fix(
        self, sample_bundle_path: Path, tmp_path: Path
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        output_name = f"test_2024-01-01_99999999.bundle"
        output_path = tmp_path / output_name
        
        save_options = SaveOptions(
            perform_crc=False,
            compression="none",
        )
        
        success, msg = save_bundle(env, output_path, save_options)
        assert success is True, msg
        
        actual_crc = CRCUtils.compute_crc32(output_path)
        assert actual_crc != 99999999

    def test_crc_fix_with_specific_target(
        self, sample_bundle_path: Path, tmp_path: Path
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        target_crc = 0xDEADBEEF
        output_name = f"test_2024-01-01_{target_crc}.bundle"
        output_path = tmp_path / output_name
        
        save_options = SaveOptions(
            perform_crc=True,
            compression="lzma",
        )
        
        success, msg = save_bundle(env, output_path, save_options)
        assert success is True, msg
        
        actual_crc = CRCUtils.compute_crc32(output_path)
        assert actual_crc == target_crc


@pytest.mark.skipif(
    not has_sample_bundle(),
    reason="sample.bundle IS REQUIRED"
)
class TestExtraBytes:
    def test_save_with_extra_bytes(
        self, sample_bundle_path: Path, tmp_path: Path
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        target_crc = 87654321
        output_name = f"test_2024-01-01_{target_crc}.bundle"
        output_path = tmp_path / output_name
        
        extra_bytes = b"\x00\x01\x02\x03\x04\x05\x06\x07"
        save_options = SaveOptions(
            perform_crc=True,
            extra_bytes=extra_bytes,
            compression="none",
        )
        
        success, msg = save_bundle(env, output_path, save_options)
        assert success is True, msg
        
        output_data = output_path.read_bytes()
        actual_crc = CRCUtils.compute_crc32(output_data)
        assert actual_crc == target_crc
        assert output_data[-len(extra_bytes) - 4 : -4] == extra_bytes

    def test_save_with_extra_bytes_and_compression(
        self, sample_bundle_path: Path, tmp_path: Path
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        target_crc = 11223344
        output_name = f"test_2077-08-08_{target_crc}.bundle"
        output_path = tmp_path / output_name
        
        extra_bytes = b"EXTRA_DATA"
        save_options = SaveOptions(
            perform_crc=True,
            extra_bytes=extra_bytes,
            compression="lzma",
        )
        
        success, msg = save_bundle(env, output_path, save_options)
        assert success is True, msg
        
        actual_crc = CRCUtils.compute_crc32(output_path)
        assert actual_crc == target_crc

    def test_extra_bytes_preserved_in_output(
        self, sample_bundle_path: Path, tmp_path: Path
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        target_crc = 55667788
        output_name = f"test_2099-06-06_{target_crc}.bundle"
        output_path = tmp_path / output_name
        
        extra_bytes = b"\xAA\xBB\xCC\xDD"
        save_options = SaveOptions(
            perform_crc=True,
            extra_bytes=extra_bytes,
            compression="none",
        )
        
        success, msg = save_bundle(env, output_path, save_options)
        assert success is True, msg
        
        output_data = output_path.read_bytes()
        assert output_data[-len(extra_bytes) - 4 : -4] == extra_bytes


@pytest.mark.skipif(
    not has_sample_bundle(),
    reason="sample.bundle IS REQUIRED"
)
class TestCombinedIO:
    @pytest.mark.parametrize("compression", ["lzma", "lz4", "none"])
    def test_compress_bundle(self, sample_bundle_path: Path, compression: str):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        data = compress_bundle(env, compression)
        assert isinstance(data, bytes)
        assert len(data) > 0

    @pytest.mark.parametrize("compression", ["lzma", "lz4", "none"])
    def test_full_roundtrip(
        self, sample_bundle_path: Path, tmp_path: Path, compression: str
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        target_crc = 99887766
        output_name = f"test_2024-01-01_{target_crc}.bundle"
        output_path = tmp_path / output_name
        
        save_options = SaveOptions(
            perform_crc=True,
            compression=compression,
        )
        
        success, msg = save_bundle(env, output_path, save_options)
        assert success is True, msg
        
        reloaded_env = load_bundle(output_path)
        assert reloaded_env is not None
        
        actual_crc = CRCUtils.compute_crc32(output_path)
        assert actual_crc == target_crc

    @pytest.mark.parametrize("compression", ["lzma", "lz4", "none"])
    def test_full_roundtrip_with_extra_bytes(
        self, sample_bundle_path: Path, tmp_path: Path, compression: str
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        target_crc = 13579246
        output_name = f"test_2024-01-01_{target_crc}.bundle"
        output_path = tmp_path / output_name
        
        extra_bytes = b"\x11\x22\x33\x44"
        save_options = SaveOptions(
            perform_crc=True,
            extra_bytes=extra_bytes,
            compression=compression,
        )
        
        success, msg = save_bundle(env, output_path, save_options)
        assert success is True, msg
        
        reloaded_env = load_bundle(output_path)
        assert reloaded_env is not None
        
        output_data = output_path.read_bytes()
        actual_crc = CRCUtils.compute_crc32(output_data)
        assert actual_crc == target_crc
        assert output_data[-len(extra_bytes) - 4 : -4] == extra_bytes

    def test_compression_lzma_smaller_than_none(
        self, sample_bundle_path: Path, tmp_path: Path
    ):
        env = load_bundle(sample_bundle_path)
        assert env is not None
        
        lzma_data = compress_bundle(env, "lzma")
        none_data = compress_bundle(env, "none")
        
        assert len(lzma_data) < len(none_data)
