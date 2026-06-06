' StreamProbe — minimal harness used by roku-mcp's roku_diagnose_stream tool to
' attempt playback of an arbitrary stream and expose the Video node's error
' fields for capture over RTA.

sub Main(args as dynamic)
  showStreamProbe(args)
end sub

sub showStreamProbe(args as dynamic)
  screen = CreateObject("roSGScreen")
  m.port = CreateObject("roMessagePort")
  screen.setMessagePort(m.port)
  scene = screen.CreateScene("StreamProbe")
  screen.show()
  ' vscode_rdb_on_device_component_entry

  ' Forward deep-link launch args (input_url, input_format, input_*) to the scene.
  if args <> invalid
    scene.launchArgs = args
  end if

  while true
    msg = wait(0, m.port)
    msgType = type(msg)
    if msgType = "roSGScreenEvent"
      if msg.isScreenClosed() then return
    end if
  end while
end sub
