extends SceneTree

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() != 1:
		quit(2)
		return
	var output := args[0]
	var scratch := output.get_base_dir()
	var aligned_file := scratch.path_join("pck-aligned.txt")
	var empty_file := scratch.path_join("pck-empty.txt")
	var err := _write_inputs(aligned_file, empty_file)
	if err == OK:
		var packer := PCKPacker.new()
		err = packer.pck_start(output, 32)
		if err == OK:
			err = packer.add_file("res://aligned.txt", aligned_file)
		if err == OK:
			err = packer.add_file("res://empty.txt", empty_file)
		if err == OK:
			err = packer.flush()
	DirAccess.remove_absolute(aligned_file)
	DirAccess.remove_absolute(empty_file)
	quit(err)

func _write_inputs(aligned_file: String, empty_file: String) -> Error:
	var aligned := FileAccess.open(aligned_file, FileAccess.WRITE)
	if aligned == null:
		return FileAccess.get_open_error()
	aligned.store_string("a".repeat(32))
	aligned.close()
	var empty := FileAccess.open(empty_file, FileAccess.WRITE)
	if empty == null:
		return FileAccess.get_open_error()
	empty.close()
	return OK
