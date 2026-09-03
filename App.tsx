/**
 * IndexBot — layout picker and ToC generation UI
 * @format
 */

import React, {useCallback, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {runIndexBotSafe} from './src/toc/runIndexBot';
import {closePlugin} from './src/utils/closePlugin';
type LayoutMode = 'outline' | 'compact' | 'numbered' | 'flat';

type Phase = 'pick' | 'running' | 'error';

const LAYOUT_OPTIONS: {id: LayoutMode; label: string; hint: string}[] = [
  {
    id: 'outline',
    label: 'Outline',
    hint: 'Bullets and indent by heading level',
  },
  {
    id: 'compact',
    label: 'Compact',
    hint: 'Indented hierarchy with leader dots',
  },
  {
    id: 'numbered',
    label: 'Numbered',
    hint: '1. / 1.1 / 1.1.1 with indent',
  },
  {id: 'flat', label: 'Flat', hint: 'Single level, no indent'},
];

function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick');
  const [layout, setLayout] = useState<LayoutMode>('compact');
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');

  const handleGenerate = useCallback(async () => {
    setPhase('running');
    setStatusText('Starting…');
    setErrorText('');

    const result = await runIndexBotSafe({
      layout,
      onStatus: status => {
        if (status?.message) {
          setStatusText(status.message);
        }
      },
    });

    if (result.ok) {
      closePlugin();
      return;
    }

    setErrorText(result.message || 'Generation failed.');
    setPhase('error');
  }, [layout]);

  if (phase === 'running') {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
        <ActivityIndicator size="large" color="#000000" />
        <Text style={styles.title}>Generating…</Text>
        <Text style={styles.body}>{statusText}</Text>
      </View>
    );
  }

  if (phase === 'error') {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
        <Text style={styles.title}>Could not generate ToC</Text>
        <Text style={styles.body}>{errorText}</Text>
        <Text style={styles.hint}>
          Details: MyStyle/IndexBot/indexbot-error.log
        </Text>
        <Pressable style={styles.btnPrimary} onPress={closePlugin}>
          <Text style={styles.btnPrimaryText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <Text style={styles.title}>IndexBot</Text>
      <Text style={styles.subtitle}>Choose a table of contents style</Text>

      {LAYOUT_OPTIONS.map(opt => {
        const selected = layout === opt.id;
        return (
          <Pressable
            key={opt.id}
            style={[styles.option, selected && styles.optionSelected]}
            onPress={() => setLayout(opt.id)}>
            <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
              {opt.label}
            </Text>
            <Text style={styles.optionHint}>{opt.hint}</Text>
          </Pressable>
        );
      })}

      <Pressable style={styles.btnPrimary} onPress={handleGenerate}>
        <Text style={styles.btnPrimaryText}>Generate ToC</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  scrollContent: {
    padding: 24,
    paddingBottom: 48,
  },
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#000000',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 18,
    color: '#000000',
    marginBottom: 20,
    textAlign: 'center',
  },
  body: {
    fontSize: 18,
    color: '#000000',
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 12,
  },
  hint: {
    fontSize: 16,
    color: '#000000',
    textAlign: 'center',
    marginBottom: 24,
  },
  option: {
    borderWidth: 2,
    borderColor: '#000000',
    padding: 16,
    marginBottom: 12,
    backgroundColor: '#ffffff',
  },
  optionSelected: {
    borderWidth: 3,
    backgroundColor: '#ffffff',
  },
  optionLabel: {
    fontSize: 22,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 4,
  },
  optionLabelSelected: {
    fontWeight: '700',
  },
  optionHint: {
    fontSize: 16,
    color: '#000000',
  },
  btnPrimary: {
    marginTop: 12,
    borderWidth: 2,
    borderColor: '#000000',
    backgroundColor: '#000000',
    paddingVertical: 16,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
});

export default App;
