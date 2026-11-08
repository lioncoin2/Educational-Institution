// The ONE file that knows Firebase (ADR 0058; test/notifications/
// notification_boundaries_test.dart keeps it so). Android only.
//
// Tokens are FCM registration tokens, the address the server's HTTP v1 send
// takes (`message.token`). firebase_messaging 17 deprecates that API in favour
// of Firebase Installation IDs; moving to them is a server change first, so
// this binding keeps the registration token on purpose, behind the exact
// version pin in pubspec.yaml.
// ignore_for_file: deprecated_member_use

import 'dart:async';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/services.dart';

import 'push_seams.dart';

/// The app's own Android side of push: its notification channels, and
/// clearing the tray. Must match `PUSH_CHANNEL` in MainActivity.kt.
const pushChannel = MethodChannel(
  'com.quraninstitution.quran_institution_app/push',
);

/// Push through Firebase Cloud Messaging, on Android.
///
/// Firebase starts lazily, on first use: a build without the project's
/// `google-services.json` cannot start it, and then this source simply has
/// no token — push is a convenience, and the inbox has everything. Nothing
/// here throws to its caller; nothing here logs a token.
class FirebasePushTokenSource implements PushTokenSource {
  FirebasePushTokenSource();

  late final Future<FirebaseMessaging?> _messaging = _start();

  Future<FirebaseMessaging?> _start() async {
    try {
      await Firebase.initializeApp();
    } on Object {
      return null; // no Firebase configuration in this build
    }
    try {
      await pushChannel.invokeMethod<void>('createChannels');
    } on Object {
      // Without its channels a push still arrives, in Android's default one.
    }
    return FirebaseMessaging.instance;
  }

  @override
  bool get isAvailable => true;

  @override
  Future<PushPermission> permission() async {
    final messaging = await _messaging;
    if (messaging == null) return PushPermission.unsupported;
    try {
      return _permissionOf(
        (await messaging.getNotificationSettings()).authorizationStatus,
      );
    } on Object {
      return PushPermission.unsupported;
    }
  }

  @override
  Future<PushPermission> requestPermission() async {
    final messaging = await _messaging;
    if (messaging == null) return PushPermission.unsupported;
    try {
      return _permissionOf(
        (await messaging.requestPermission()).authorizationStatus,
      );
    } on Object {
      return PushPermission.unsupported;
    }
  }

  @override
  Future<PushToken?> token() async {
    final messaging = await _messaging;
    if (messaging == null) return null;
    try {
      // Off in the manifest, so no token exists before someone signs in.
      await messaging.setAutoInitEnabled(true);
      final value = await messaging.getToken();
      return value == null || value.isEmpty ? null : _tokenOf(value);
    } on Object {
      return null;
    }
  }

  @override
  Stream<PushToken> get tokenRefreshes =>
      Stream.fromFuture(_messaging).asyncExpand(
        (messaging) => messaging == null
            ? const Stream.empty()
            : messaging.onTokenRefresh.map(_tokenOf),
      );

  @override
  Future<PushTap?> initialTap() async {
    final messaging = await _messaging;
    if (messaging == null) return null;
    try {
      final message = await messaging.getInitialMessage();
      return message == null ? null : PushTap.fromData(message.data);
    } on Object {
      return null;
    }
  }

  @override
  Stream<PushTap> get taps => Stream.fromFuture(_messaging).asyncExpand(
    (messaging) => messaging == null
        ? const Stream.empty()
        : FirebaseMessaging.onMessageOpenedApp.map(
            (message) => PushTap.fromData(message.data),
          ),
  );

  @override
  Future<void> disable() async {
    final messaging = await _messaging;
    if (messaging == null) return;
    try {
      await messaging.setAutoInitEnabled(false);
      await messaging.deleteToken();
    } on Object {
      // Offline: the server stops pushing to a signed-out session anyway.
    }
    try {
      await pushChannel.invokeMethod<void>('clearNotifications');
    } on Object {
      // Nothing to clear.
    }
  }

  @override
  Future<bool> wasOffered() async {
    try {
      return await pushChannel.invokeMethod<bool>('wasOffered') ?? false;
    } on Object {
      return true; // cannot tell: better not to ask again
    }
  }

  @override
  Future<void> markOffered() async {
    try {
      await pushChannel.invokeMethod<void>('markOffered');
    } on Object {
      // Asked again next time.
    }
  }

  static PushToken _tokenOf(String value) =>
      PushToken(platform: 'ANDROID', provider: 'FCM', value: value);

  static PushPermission _permissionOf(AuthorizationStatus status) =>
      switch (status) {
        AuthorizationStatus.authorized ||
        AuthorizationStatus.provisional => PushPermission.granted,
        AuthorizationStatus.notDetermined => PushPermission.notDetermined,
        AuthorizationStatus.denied => PushPermission.denied,
        AuthorizationStatus.deniedPermanently =>
          PushPermission.deniedPermanently,
      };
}
