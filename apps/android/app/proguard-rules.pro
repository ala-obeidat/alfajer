# libwebrtc calls back into Java via JNI; its AAR ships consumer rules, these
# are a belt-and-braces keep for the classes JNI looks up by name.
-keep class org.webrtc.** { *; }
-dontwarn org.webrtc.**
