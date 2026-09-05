/**
 * IndexBot — layout picker and ToC generation UI
 * @format
 */

import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import {runIndexBotSafe} from './src/toc/runIndexBot';
import {checkInsertPage} from './src/toc/checkInsertPage';
import {closePlugin} from './src/utils/closePlugin';

type LayoutMode = 'outline' | 'compact' | 'numbered' | 'flat';
type RunMode = 'initial' | 'refresh';

type Phase = 'pick' | 'running' | 'error';

type PreflightState = {
  ready: boolean;
  mode: RunMode;
  message: string;
  loading: boolean;
};

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

const WARNING_INITIAL =
  'IndexBot will put the ToC on page 1. If page 1 already has notes, a blank page is inserted first.';

const WARNING_REFRESH =
  'An IndexBot ToC exists on page 1. Generate will re-scan the note and update it. You can run this from any page.';

function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('pick');
  const [layout, setLayout] = useState<LayoutMode>('compact');
  const [snapBack, setSnapBack] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [errorText, setErrorText] = useState('');
  const [preflight, setPreflight] = useState<PreflightState>({
    ready: false,
    mode: 'initial',
    message: 'Checking page…',
    loading: true,
  });

  const refreshPreflight = useCallback(async () => {
    setPreflight(p => ({...p, loading: true, message: 'Checking page…'}));
    const result = await checkInsertPage();
    setPreflight({
      ready: result.ready,
      mode: result.mode as RunMode,
      message: result.message,
      loading: false,
    });
  }, []);

  useEffect(() => {
    refreshPreflight();
  }, [refreshPreflight]);

  const handleGenerate = useCallback(async () => {
    if (!preflight.ready) return;

    setPhase('running');
    setStatusText('Starting…');
    setErrorText('');

    const result = await runIndexBotSafe({
      layout,
      snapBack,
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
  }, [layout, snapBack, preflight.ready]);

  const handleBackFromError = useCallback(() => {
    setPhase('pick');
    refreshPreflight();
  }, [refreshPreflight]);

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
        <Pressable style={styles.btnPrimary} onPress={handleBackFromError}>
          <Text style={styles.btnPrimaryText}>Back</Text>
        </Pressable>
        <Pressable style={[styles.btnSecondary, {marginTop: 12}]} onPress={closePlugin}>
          <Text style={styles.btnSecondaryText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  const warningText =
    preflight.mode === 'refresh' ? WARNING_REFRESH : WARNING_INITIAL;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}>
      <StatusBar barStyle="dark-content" backgroundColor="#ffffff" />
      <Text style={styles.title}>IndexBot</Text>
      <Text style={styles.subtitle}>Choose a table of contents style</Text>

      <View style={styles.warningBox}>
        <Text style={styles.warningText}>{warningText}</Text>
        <Text style={styles.statusText}>
          {preflight.loading ? 'Checking page…' : preflight.message}
        </Text>
      </View>

      {LAYOUT_OPTIONS.map(opt => {
        const selected = layout === opt.id;
        return (
          <Pressable
            key={opt.id}
            style={[styles.option, selected && styles.optionSelected]}
            onPress={() => setLayout(opt.id)}>
            <Text
              style={[
                styles.optionLabel,
                selected && styles.optionLabelSelected,
              ]}>
              {opt.label}
            </Text>
            <Text style={styles.optionHint}>{opt.hint}</Text>
          </Pressable>
        );
      })}

      <View style={styles.toggleRow}>
        <View style={styles.toggleTextCol}>
          <Text style={styles.toggleLabel}>Snap-back links</Text>
          <Text style={styles.optionHint}>
            Add a ← ToC link on each heading page back to page 1
          </Text>
        </View>
        <Switch
          value={snapBack}
          onValueChange={setSnapBack}
          trackColor={{false: '#cccccc', true: '#000000'}}
          thumbColor="#ffffff"
        />
      </View>

      <Pressable
        style={[
          styles.btnPrimary,
          (!preflight.ready || preflight.loading) && styles.btnDisabled,
        ]}
        onPress={handleGenerate}
        disabled={!preflight.ready || preflight.loading}>
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
    marginBottom: 16,
    textAlign: 'center',
  },
  warningBox: {
    borderWidth: 2,
    borderColor: '#000000',
    padding: 16,
    marginBottom: 20,
    backgroundColor: '#ffffff',
  },
  warningText: {
    fontSize: 17,
    color: '#000000',
    marginBottom: 10,
    lineHeight: 24,
  },
  statusText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000000',
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
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#000000',
    padding: 16,
    marginBottom: 12,
    backgroundColor: '#ffffff',
  },
  toggleTextCol: {
    flex: 1,
    paddingRight: 12,
  },
  toggleLabel: {
    fontSize: 20,
    fontWeight: '600',
    color: '#000000',
    marginBottom: 4,
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
  btnDisabled: {
    backgroundColor: '#888888',
    borderColor: '#888888',
  },
  btnPrimaryText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
  },
  btnSecondary: {
    borderWidth: 2,
    borderColor: '#000000',
    backgroundColor: '#ffffff',
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  btnSecondaryText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#000000',
  },
});

export default App;
