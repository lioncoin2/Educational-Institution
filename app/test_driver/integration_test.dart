import 'dart:convert';
import 'dart:io';

import 'package:integration_test/integration_test_driver.dart';

Future<void> main() => integrationDriver(
  responseDataCallback: (data) async {
    if (data != null) {
      await File('build/trial_progress.json').writeAsString(jsonEncode(data));
    }
  },
);
