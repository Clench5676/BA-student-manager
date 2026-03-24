# gui/tabs/jp_conversion_tab.py

import tkinter as tk
import ttkbootstrap as tb
from tkinter import messagebox
from pathlib import Path

from ...i18n import t
from ... import core
from ...utils import get_search_resource_dirs
from ..base_tab import TabFrame
from ..components import DropZone, FileListbox, ModeSwitcher, SettingRow, UIComponents
from ..dialogs import FileSelectionDialog

class JPGLConversionTab(TabFrame):
    """日服与国际服格式互相转换的标签页"""

    def create_widgets(self):
        # --- 转换模式选择 ---
        self.mode_var = tk.StringVar(value="jp_to_global")
        
        self.mode_switcher = ModeSwitcher(
            self,
            self.mode_var,
            [
                ("jp_to_global", t("ui.jp_conversion.mode_jp_to_gl")),
                ("global_to_jp", t("ui.jp_conversion.mode_gl_to_jp"))
            ],
            command=self._switch_view
        )

        # --- 文件输入区域 ---
        self.file_frame = tb.Frame(self)
        self.file_frame.pack(fill=tk.BOTH, expand=True, pady=(0, 3))
        
        # 1. 国际服 Bundle 文件
        self.global_zone = DropZone(
            self.file_frame,
            title=t("ui.jp_conversion.role_global_source"),
            placeholder_text=t("ui.jp_conversion.placeholder_global_bundle"),
            on_file_selected=self.on_global_selected,
            filetypes=[(t("file_type.bundle"), "*.bundle"), (t("file_type.all_files"), "*.*")],
            logger=self.logger
        )

        # 2. 日服 Bundle 文件列表 (FileListbox，支持多文件)
        self.jp_files_listbox = FileListbox(
            self.file_frame,
            title=t("ui.jp_conversion.role_jp_source"),
            placeholder_text=t("ui.jp_conversion.placeholder_jp_files"),
            height=3,
            logger=self.logger,
            on_files_added=self._on_jp_files_added
        )
        self.jp_files_listbox.get_frame().pack(fill=tk.BOTH, expand=True)
        
        # --- 选项设置区域 ---
        options_frame = tb.Labelframe(self, text=t("ui.label.options"), padding=10)
        options_frame.pack(fill=tk.X)
        
        # 自动搜索开关
        SettingRow.create_switch(
            options_frame,
            label=t("option.auto_search"),
            variable=self.app.auto_search_var,
            tooltip=t("option.auto_search_info")
        )
        
        # --- 操作按钮 ---
        action_button_frame = tb.Frame(self)
        action_button_frame.pack(fill=tk.X, pady=2)
        
        self.run_button = UIComponents.create_button(
            action_button_frame, t("action.convert"),
            self.run_conversion_thread,
            bootstyle="success",
            style="large"
        )
        self.run_button.pack(fill=tk.X, pady=10)
        
        # 初始化视图标签
        self._switch_view()
    
    def _switch_view(self):
        """根据选择的模式更新UI文案"""
        if self.mode_var.get() == "jp_to_global":
            self.global_zone.config(text=t("ui.jp_conversion.role_global_target"))
            self.jp_files_listbox.get_frame().config(text=t("ui.jp_conversion.role_jp_source"))
        else:
            self.global_zone.config(text=t("ui.jp_conversion.role_global_source"))
            self.jp_files_listbox.get_frame().config(text=t("ui.jp_conversion.role_jp_target"))

    def on_global_selected(self, path: Path):
        """Global 文件选中后的处理"""
        self.logger.log(t("log.file.loaded", path=path))
        self.logger.status(t("status.ready"))
        # 自动搜索 JP 文件
        if self.app.auto_search_var.get():
            self._auto_find_jp_files()

    # --- 自动搜索逻辑 ---
    def _auto_find_jp_files(self):
        """当指定了 Global 文件后，自动在资源目录查找所有匹配的 JP 文件"""
        if not self.app.game_resource_dir_var.get():
            self.logger.log(f'⚠️ {t("log.jp_convert.auto_search_no_game_dir")}')
            return
        if not self.global_zone.path:
            self.logger.log(f'⚠️ {t("log.file.not_exist", path=self.global_zone.path)}')
            return
        
        # 清除旧的 JP 文件列表，准备重新搜索
        self.jp_files_listbox._clear_list()
        self.run_in_thread(self._find_worker)

    def _find_worker(self):
        self.logger.status(t("status.searching"))
        base_game_dir = Path(self.app.game_resource_dir_var.get())
        game_search_dirs = get_search_resource_dirs(base_game_dir, self.app.auto_detect_subdirs_var.get())

        jp_files = core.find_all_jp_counterparts(
            self.global_zone.path, game_search_dirs, self.logger.log
        )
        
        if jp_files:
            self.master.after(0, lambda: self._update_jp_listbox(jp_files))
            self.logger.status(t("status.ready"))
        else:
            self.logger.log(f'⚠️ {t("log.search.no_found")}')
            self.logger.status(t("status.search_not_found"))

    def _update_jp_listbox(self, files: list[Path]):
        self.jp_files_listbox._clear_list()
        self.jp_files_listbox.add_files(files)
        self.logger.log(t("log.search.found_count", count=len(files)))

    # --- 反向查找：JP文件添加后自动查找Global文件 ---
    def _on_jp_files_added(self, paths: list[Path]) -> None:
        """当JP文件被添加时的回调，如果是第一个文件且开启了自动搜索，则查找对应的Global文件"""
        if not self.app.auto_search_var.get():
            return
        if not paths:
            return
        # 只有当Global文件未设置时才进行查找
        if self.global_zone.path is not None:
            return
        # 使用第一个JP文件作为查找基础
        first_jp_file = paths[0]
        self._auto_find_global_file(first_jp_file)

    def _auto_find_global_file(self, jp_file: Path):
        """当指定了JP文件后，自动在资源目录查找对应的Global文件"""
        if not self.app.game_resource_dir_var.get():
            self.logger.log(f'⚠️ {t("log.jp_convert.auto_search_no_game_dir")}')
            return

        self.run_in_thread(lambda: self._find_global_worker(jp_file))

    def _find_global_worker(self, jp_file: Path):
        """后台线程：查找Global文件"""
        self.logger.status(t("status.searching"))

        # 更新UI为搜索中状态
        self.master.after(0, lambda: self.global_zone.set_searching())

        base_game_dir = Path(self.app.game_resource_dir_var.get())
        search_paths = get_search_resource_dirs(base_game_dir, self.app.auto_detect_subdirs_var.get())

        # 使用find_new_bundle_path查找Global文件
        found_paths, message = core.find_new_bundle_path(
            jp_file,
            search_paths,
            self.logger.log
        )

        # 在主线程中处理结果
        self.master.after(0, lambda: self._handle_global_search_result(found_paths, message))

    def _handle_global_search_result(self, found_paths: list[Path], message: str):
        """处理Global文件搜索结果"""
        if not found_paths:
            # 没有找到匹配文件
            ui_message = t("ui.mod_update.status_not_found", message=message)
            self.global_zone.set_error(ui_message)
            self.logger.status(t("status.search_not_found"))
        elif len(found_paths) == 1:
            self.global_zone.set_path(found_paths[0])
            self.logger.log(t("log.file.loaded", path=found_paths[0]))
            self.logger.status(t("status.ready"))
        else:
            # 多个匹配文件，弹出选择对话框
            dialog = FileSelectionDialog(
                self.master,
                title=t("ui.dialog.select_file"),
                candidates=found_paths,
                message=t("ui.dialog.multiple_matches_found", count=len(found_paths)),
                display_formatter=lambda p: f"{p.parent.name} / {p.name}"
            )

            selected_path = dialog.get_selected_path()
            if selected_path:
                self.global_zone.set_path(selected_path)
                self.logger.log(t("log.file.loaded", path=selected_path))
                self.logger.status(t("status.ready"))
            else:
                # 用户取消了选择
                ui_message = t("ui.mod_update.status_not_found", message=t("ui.dialog.selection_cancelled"))
                self.global_zone.set_warning(ui_message)
                self.logger.status(t("status.search_not_found"))

    # --- 核心转换流程 ---
    def run_conversion_thread(self):
        self.run_in_thread(self.run_conversion)
    
    def run_conversion(self):
        # 1. 验证输入
        output_dir = Path(self.app.output_dir_var.get())
        jp_files = self.jp_files_listbox.file_list
        
        if not self.global_zone.path:
            messagebox.showerror(t("common.error"), t("message.no_file_selected"))
            return
        if not jp_files:
            messagebox.showerror(t("common.error"), t("message.list_empty"))
            return

        try:
            output_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            self.logger.log(f'❌ {t("message.create_dir_failed_detail",path=output_dir, error=e)}')
            return
        
        # 2. 准备选项
        crc_setting = self.app.enable_crc_correction_var.get()
        perform_crc = False
        
        if crc_setting == "auto":
            target_bundle = self.global_zone.path if self.mode_var.get() == "jp_to_global" else jp_files[0]
            platform, unity_version = core.get_unity_platform_info(target_bundle)
            self.logger.log(t("log.platform_info", platform=platform, version=unity_version))
            perform_crc = (platform == "StandaloneWindows64") and (self.mode_var.get() == "jp_to_global")
        elif crc_setting == "true":
            perform_crc = True
        
        save_options = core.SaveOptions(
            perform_crc=perform_crc,
            extra_bytes=self.app.get_extra_bytes(),
            compression=self.app.compression_method_var.get()
        )
        
        # 3. 调用处理函数
        self.logger.status(t("common.processing"))
        if self.mode_var.get() == "jp_to_global":
            success, message = core.process_jp_to_global_conversion(
                global_bundle_path=self.global_zone.path,
                jp_bundle_paths=jp_files,
                output_dir=output_dir,
                save_options=save_options,
                log=self.logger.log
            )
        else:
            success, message = core.process_global_to_jp_conversion(
                global_bundle_path=self.global_zone.path,
                jp_template_paths=jp_files,
                output_dir=output_dir,
                save_options=save_options,
                log=self.logger.log
            )
        
        # 4. 结果反馈
        if success:
            self.logger.status(t("status.done"))
            messagebox.showinfo(t("common.success"), message)
        else:
            self.logger.status(t("status.failed"))
            messagebox.showerror(t("common.fail"), message)