import pytest
from pathlib import Path
from PIL import Image

from ba_modding_toolkit.core import (
    process_asset_extraction,
)
from conftest import has_sample_bundle


@pytest.mark.skipif(
    not has_sample_bundle(),
    reason="sample.bundle IS REQUIRED"
)
class TestAssetExtraction:
    def test_extract_texture2d(self, sample_bundle_path: Path, tmp_path: Path):
        output_dir = tmp_path / "extracted"
        output_dir.mkdir()
        
        success, msg = process_asset_extraction(
            bundle_path=sample_bundle_path,
            output_dir=output_dir,
            asset_types_to_extract={"Texture2D"},
        )
        
        assert success is True
        
        png_files = list(output_dir.glob("*.png"))
        assert len(png_files) > 0
        
        for png_file in png_files:
            img = Image.open(png_file)
            assert img.mode == "RGBA"

    def test_extract_textasset(self, sample_bundle_path: Path, tmp_path: Path):
        output_dir = tmp_path / "extracted"
        output_dir.mkdir()
        
        success, msg = process_asset_extraction(
            bundle_path=sample_bundle_path,
            output_dir=output_dir,
            asset_types_to_extract={"TextAsset"},
        )
        
        assert success is True

    def test_extract_multiple_types(self, sample_bundle_path: Path, tmp_path: Path):
        output_dir = tmp_path / "extracted"
        output_dir.mkdir()
        
        success, msg = process_asset_extraction(
            bundle_path=sample_bundle_path,
            output_dir=output_dir,
            asset_types_to_extract={"Texture2D", "TextAsset"},
        )
        
        assert success is True

    def test_extract_to_nonexistent_dir(self, sample_bundle_path: Path, tmp_path: Path):
        output_dir = tmp_path / "new_dir"
        
        success, msg = process_asset_extraction(
            bundle_path=sample_bundle_path,
            output_dir=output_dir,
            asset_types_to_extract={"Texture2D"},
        )
        
        assert success is True
        assert output_dir.exists()
