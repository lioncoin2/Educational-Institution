import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app/app.dart';
import 'app/url_strategy.dart';

void main() {
  configureUrlStrategy();
  runApp(const ProviderScope(child: QuranInstitutionApp()));
}
